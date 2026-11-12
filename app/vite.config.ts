import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const app = fileURLToPath(new URL(".", import.meta.url));
const core = fileURLToPath(new URL("../keeper/src/core", import.meta.url));
const idl = fileURLToPath(new URL("../keeper/idl", import.meta.url));
const mobileStub = fileURLToPath(new URL("./src/stubs/mobile-wallet-adapter.ts", import.meta.url));

/**
 * The wallet modal stylesheet starts with an @import of Google Fonts. This
 * app loads nothing from third-party hosts, so the @import is removed and the
 * modal uses the system font (see styles.css).
 */
function noRemoteCssImports(): Plugin {
  return {
    name: "no-remote-css-imports",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("wallet-adapter-react-ui") || !id.split("?")[0]!.endsWith(".css")) return null;
      return { code: code.replace(/@import\s+url\(['"]?https?:[^)]*\)\s*;?/g, ""), map: null };
    },
  };
}

// Local-only app: both servers bind to the loopback address, nothing is
// fetched from a CDN, and the shared keeper core is imported from source.
export default defineConfig({
  plugins: [noRemoteCssImports(), react()],
  resolve: {
    alias: {
      "@core": core,
      "@solana-mobile/wallet-adapter-mobile": mobileStub,
    },
    // keeper/src/core imports these by bare name; resolve them once, from
    // app/node_modules, so PublicKey/BN instances are the same classes.
    dedupe: ["@solana/web3.js", "@anchor-lang/core", "bn.js", "buffer", "react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { strict: true, allow: [app, core, idl] },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  optimizeDeps: {
    esbuildOptions: { target: "es2022" },
  },
});
