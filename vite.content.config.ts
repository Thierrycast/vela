import { defineConfig } from "vite";

// O content script precisa ser um arquivo clássico e autossuficiente: scripts injetados
// por `files` não suportam `import`. Um build separado com inlineDynamicImports garante isso.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: { content: "src/content-entry.ts" },
      output: { entryFileNames: "content.js", inlineDynamicImports: true, format: "iife" },
    },
  },
});
