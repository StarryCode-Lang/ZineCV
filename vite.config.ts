import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [react(), svelte()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  preview: { host: "127.0.0.1", port: 5174, strictPort: true },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/react-dom/") || id.includes("node_modules/react/")) {
            return "react-vendor";
          }
          if (id.includes("node_modules/motion/")) {
            return "motion-vendor";
          }
          if (id.includes("node_modules/lucide-react/")) {
            return "icons";
          }
          if (id.includes("node_modules/html2canvas/") || id.includes("node_modules/jspdf/")) {
            return "export-tools";
          }
          if (
            id.includes("node_modules/pdfjs-dist/") ||
            id.includes("node_modules/mammoth/") ||
            id.includes("node_modules/tesseract.js/") ||
            id.includes("node_modules/docx-preview/")
          ) {
            return "import-tools";
          }
        },
      },
    },
  },
});
