import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

/**
 * Vite config for the CE website.
 *
 * The important line is the `node:crypto` alias. CE's hash functions are
 * synchronous by design — they run inside the tick loop and their output is part
 * of world identity — so `crypto.subtle.digest()` (async) cannot be substituted.
 * Instead the engine's two `node:crypto` importers resolve to a synchronous
 * SHA-256 shim at bundle time.
 *
 * No engine source is modified. CE is research-frozen; this is a build concern.
 *
 * Parity is enforced by two scripts in the parent repo:
 *   scripts/verify-shim.mjs            shim vs node:crypto, 30 assertions
 *   scripts/verify-browser-parity.mjs  real engine through the shim, 30 assertions
 *
 * The second one confirms the shim-backed engine reproduces the P-014 baseline
 * state hash `5404d32e…` exactly, which is why the demo can display real hashes.
 */
export default defineConfig({
  base: process.env.CE_WEB_BASE ?? "/causality-engine/",

  resolve: {
    alias: [
      {
        find: /^node:crypto$/,
        replacement: fileURLToPath(new URL("./src/node-crypto-shim.ts", import.meta.url)),
      },
      {
        // The engine is consumed from the parent repo's build output, so the
        // site always demonstrates the same code that ships.
        find: "causality-engine/product",
        replacement: fileURLToPath(new URL("../dist/api/product.js", import.meta.url)),
      },
    ],
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // The engine is the large payload; splitting it lets the page paint
          // before the demo is interactive.
          engine: ["causality-engine/product"],
        },
      },
    },
  },

  server: {
    port: 5173,
    open: true,
  },
});
