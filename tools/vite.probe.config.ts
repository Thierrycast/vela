import { defineConfig } from "vite";
export default defineConfig({
  build: {
    outDir: process.env.PROBE_OUT ?? "tools/out",
    emptyOutDir: false,
    rollupOptions: { input: "tools/snapshot-probe.ts", output: { entryFileNames: "snapshot-probe.js", inlineDynamicImports: true, format: "iife" } },
  },
});
