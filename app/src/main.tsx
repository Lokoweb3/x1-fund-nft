import "./polyfills";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// No React StrictMode: in development it unmounts and remounts once, and
// @solana/wallet-standard-wallet-adapter-react destroys the live wallet
// adapters in that unmount cleanup, so they stop receiving the wallet's
// account-change events (a disconnect or account switch would go unseen).
createRoot(document.getElementById("root")!).render(<App />);
