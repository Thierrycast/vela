import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: "index.html",
        options: "options.html",
        debug: "debug.html",
        background: "src/background.ts",
        offscreen: "offscreen.html",
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "background" || chunk.name === "content" || chunk.name === "offscreen" ? "[name].js" : "assets/[name]-[hash].js",
      },
    },
  },
});
