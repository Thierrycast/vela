import { defineConfig } from "vite";
export default defineConfig({
  build: {
    ssr: true,
    outDir: process.env.HARNESS_OUT ?? "tools/out",
    emptyOutDir: false,
    target: "node22",
    rollupOptions: { input: "tools/loop-harness.ts", output: { entryFileNames: "harness.mjs", format: "esm" } },
  },
});
