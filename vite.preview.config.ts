import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Serve a UI real fora da extensão para ferramentas de review de interface, que não
// conseguem abrir páginas chrome-extension://.
export default defineConfig({
  root: "tools/preview",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5178, strictPort: true, open: false },
});
