/**
 * Owner CLI: argument parsing and the env-driven send gate. The transaction
 * builders, bounds, size checks, fee math and sendPlan live in core/owner.ts
 * (browser-safe, shared with the web app in app/) and are re-exported here so
 * the CLI and its tests keep one import path.
 */
import { PublicKey } from "@solana/web3.js";
import { assertSendAllowed, CLUSTERS, isCluster, type Cluster } from "./core/cluster.js";
import {
  computeBudgetFromEnv,
  I64_MAX,
  parsePubkey,
  parseUint,
  U64_MAX,
  validateCreateFund,
  type ComputeBudget,
  type CreateFundArgs,
  type EnvLike,
  type TargetSpec,
} from "./core/owner.js";
import { validateMetadataFields, validateMetadataUpdate, type MetadataFields, type MetadataUpdate } from "./core/metadata.js";

export * from "./core/owner.js";
export * from "./core/metadata.js";

export type Command = "create-fund" | "deposit" | "withdraw" | "show" | "ensure-vaults" | "set-metadata";
export const COMMANDS: readonly Command[] = ["create-fund", "deposit", "withdraw", "show", "ensure-vaults", "set-metadata"];

export interface CommonOptions {
  send: boolean;
  cluster: Cluster | undefined;
  iUnderstandMainnet: boolean;
  payer: PublicKey | undefined;
  rpcUrl: string | undefined;
  xdex: PublicKey | undefined;
}

export type ParsedCli =
  | { command: "create-fund"; options: CommonOptions; create: CreateFundArgs; metadata: MetadataFields | undefined }
  | { command: "deposit"; options: CommonOptions; fund: PublicKey; amount: bigint }
  | { command: "withdraw"; options: CommonOptions; fund: PublicKey; mint: PublicKey; amount: bigint | "all" }
  | { command: "show"; options: CommonOptions; fund: PublicKey }
  | { command: "ensure-vaults"; options: CommonOptions; fund: PublicKey }
  | { command: "set-metadata"; options: CommonOptions; fund: PublicKey; update: MetadataUpdate };

const VALUE_FLAGS = new Set([
  "--quote",
  "--target",
  "--per-run",
  "--interval",
  "--window",
  "--max-dev-bps",
  "--fund",
  "--amount",
  "--mint",
  "--payer",
  "--cluster",
  "--rpc",
  "--xdex",
  "--name",
  "--symbol",
  "--uri",
]);
const BOOL_FLAGS = new Set(["--send", "--i-understand-mainnet"]);

const ALLOWED: Record<Command, string[]> = {
  "create-fund": [
    "--quote",
    "--target",
    "--per-run",
    "--interval",
    "--window",
    "--max-dev-bps",
    "--xdex",
    "--name",
    "--symbol",
    "--uri",
  ],
  deposit: ["--fund", "--amount"],
  withdraw: ["--fund", "--mint", "--amount"],
  show: ["--fund"],
  "ensure-vaults": ["--fund"],
  "set-metadata": ["--fund", "--name", "--symbol", "--uri"],
};
const COMMON = ["--payer", "--cluster", "--rpc", "--send", "--i-understand-mainnet"];

export const USAGE = `usage: npx tsx src/cli.ts <command> [flags]

commands:
  create-fund --quote <mint> --target <mint>:<pool>:<bps> [--target ...]
              --per-run <raw> --interval <secs> --window <secs> --max-dev-bps <n>
              [--name <text> --symbol <text> --uri <url>]
              (the cash slice is --target <quoteMint>:default:<bps>; localnet only: --xdex <id>;
               --name/--symbol/--uri together attach NFT metadata as tx 2)
  deposit     --fund <pda> --amount <raw>
  withdraw    --fund <pda> --mint <mint> --amount <raw|all>
  show        --fund <pda>
  ensure-vaults --fund <pda>   create any missing quote/target vault ATAs (idempotent)
  set-metadata --fund <pda> [--name <text>] [--symbol <text>] [--uri <url>]
              NFT holder only: attach metadata (all three needed) or update the given fields
              (limits: name 32, symbol 10, uri 200 UTF-8 bytes)

common flags:
  --payer <pubkey>          fee payer / signer for simulation when KEYPAIR is unset
  --rpc <url>               RPC endpoint (default: $RPC_URL, else https://rpc.mainnet.x1.xyz)
  --send                    send instead of simulate; also needs KEYPAIR and --cluster
  --cluster <${CLUSTERS.join("|")}>   must match the RPC's genesis hash
  --i-understand-mainnet    required, with --cluster mainnet, to send to X1 mainnet

Default is simulate-only. env: KEYPAIR, RPC_URL, COMPUTE_UNIT_LIMIT, PRIORITY_FEE_MICROLAMPORTS`;

/** `<mint>:<pool>:<bps>`; pool `default` (or the all-zero key) marks the cash slice. */
export function parseTarget(spec: string): TargetSpec {
  const parts = spec.split(":");
  if (parts.length !== 3) throw new Error(`--target ${JSON.stringify(spec)} must be <mint>:<pool>:<bps>`);
  const [mint, pool, bps] = parts as [string, string, string];
  return {
    mint: parsePubkey(mint, "--target mint"),
    pool: pool === "default" ? PublicKey.default : parsePubkey(pool, "--target pool"),
    bps: Number(parseUint(bps, "--target bps", 65_535n)),
  };
}

export function parseCli(argv: string[]): ParsedCli {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") throw new Error(USAGE);
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`unknown command ${JSON.stringify(command)}\n${USAGE}`);
  }
  const cmd = command as Command;
  const allowed = new Set([...ALLOWED[cmd], ...COMMON]);
  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    let arg = rest[i]!;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (!allowed.has(arg)) throw new Error(`${cmd}: unknown or misplaced argument ${arg}\n${USAGE}`);
    if (BOOL_FLAGS.has(arg)) {
      if (inline !== undefined) throw new Error(`${arg} takes no value`);
      bools.add(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      const value = inline ?? rest[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new Error(`${arg} needs a value`);
      }
      const list = values.get(arg) ?? [];
      list.push(value);
      values.set(arg, list);
    }
  }
  const one = (flag: string): string | undefined => {
    const list = values.get(flag);
    if (!list) return undefined;
    if (list.length > 1) throw new Error(`${flag} given more than once`);
    return list[0];
  };
  const need = (flag: string): string => {
    const value = one(flag);
    if (value === undefined) throw new Error(`${cmd} requires ${flag}`);
    return value;
  };

  const clusterValue = one("--cluster");
  if (clusterValue !== undefined && !isCluster(clusterValue)) {
    throw new Error(`--cluster must be one of ${CLUSTERS.join(", ")}`);
  }
  const payerValue = one("--payer");
  const xdexValue = one("--xdex");
  const options: CommonOptions = {
    send: bools.has("--send"),
    cluster: clusterValue as Cluster | undefined,
    iUnderstandMainnet: bools.has("--i-understand-mainnet"),
    payer: payerValue === undefined ? undefined : parsePubkey(payerValue, "--payer"),
    rpcUrl: one("--rpc"),
    xdex: xdexValue === undefined ? undefined : parsePubkey(xdexValue, "--xdex"),
  };

  switch (cmd) {
    case "create-fund": {
      const create: CreateFundArgs = {
        quote: parsePubkey(need("--quote"), "--quote"),
        targets: (values.get("--target") ?? []).map(parseTarget),
        perRun: parseUint(need("--per-run"), "--per-run", U64_MAX),
        interval: parseUint(need("--interval"), "--interval", I64_MAX),
        window: Number(parseUint(need("--window"), "--window", 0xffff_ffffn)),
        maxDevBps: Number(parseUint(need("--max-dev-bps"), "--max-dev-bps", 0xffffn)),
      };
      validateCreateFund(create);
      const name = one("--name");
      const symbol = one("--symbol");
      const uri = one("--uri");
      let metadata: MetadataFields | undefined;
      if (name !== undefined || symbol !== undefined || uri !== undefined) {
        if (name === undefined || symbol === undefined || uri === undefined) {
          throw new Error("create-fund: --name, --symbol and --uri go together (all three or none)");
        }
        metadata = { name, symbol, uri };
        validateMetadataFields(metadata);
      }
      return { command: cmd, options, create, metadata };
    }
    case "deposit": {
      const amount = parseUint(need("--amount"), "--amount", U64_MAX);
      if (amount === 0n) throw new Error("--amount must be greater than zero");
      return { command: cmd, options, fund: parsePubkey(need("--fund"), "--fund"), amount };
    }
    case "withdraw": {
      const raw = need("--amount");
      const amount = raw === "all" ? "all" : parseUint(raw, "--amount", U64_MAX);
      if (amount === 0n) throw new Error("--amount must be greater than zero");
      return {
        command: cmd,
        options,
        fund: parsePubkey(need("--fund"), "--fund"),
        mint: parsePubkey(need("--mint"), "--mint"),
        amount,
      };
    }
    case "show":
    case "ensure-vaults":
      return { command: cmd, options, fund: parsePubkey(need("--fund"), "--fund") };
    case "set-metadata": {
      const update: MetadataUpdate = {};
      const name = one("--name");
      const symbol = one("--symbol");
      const uri = one("--uri");
      if (name !== undefined) update.name = name;
      if (symbol !== undefined) update.symbol = symbol;
      if (uri !== undefined) update.uri = uri;
      if (name === undefined && symbol === undefined && uri === undefined) {
        throw new Error("set-metadata needs at least one of --name, --symbol, --uri");
      }
      validateMetadataUpdate(update);
      return { command: cmd, options, fund: parsePubkey(need("--fund"), "--fund"), update };
    }
  }
}

/** Same env vars and bounds as the keeper (src/index.ts). */
export function computeBudget(env: EnvLike = process.env): ComputeBudget {
  return computeBudgetFromEnv(env);
}

export interface SendGateInput {
  options: CommonOptions;
  genesisHash: string;
  rpcUrl: string;
  keypairEnv: string | undefined;
}

/**
 * Decide simulate vs send. Called after getGenesisHash and before any keypair
 * is loaded. Without --send it always simulates. With --send it requires
 * KEYPAIR and the keeper's cluster guard (--cluster matching genesis, and
 * --i-understand-mainnet for mainnet); any failure throws.
 */
export function sendGate(input: SendGateInput): { send: boolean; cluster?: Cluster } {
  if (!input.options.send) return { send: false };
  if (!input.keypairEnv) throw new Error("refusing to send: --send needs KEYPAIR set to a JSON keypair file");
  const cluster = assertSendAllowed({
    clusterFlag: input.options.cluster,
    genesisHash: input.genesisHash,
    iUnderstandMainnet: input.options.iUnderstandMainnet,
    rpcUrl: input.rpcUrl,
  });
  return { send: true, cluster };
}

