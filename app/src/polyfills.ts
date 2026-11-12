// web3.js and Anchor expect a global Buffer. Imported first by main.tsx.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
