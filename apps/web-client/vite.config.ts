import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "src",
  // Serve Tarot art directly (copied into dist at build time).
  publicDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/game-data/content/art"),
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
