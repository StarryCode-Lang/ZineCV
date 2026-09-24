import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { versionStoragePlugin } from "./server/version-storage.mjs";
import { agentGatewayPlugin } from "./server/agent-gateway.mjs";

export default defineConfig({
  plugins: [react(), versionStoragePlugin(), agentGatewayPlugin()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 5173, strictPort: true },
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
