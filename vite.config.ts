import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { versionStoragePlugin } from "./server/version-storage.mjs";
import { agentGatewayPlugin } from "./server/agent-gateway.mjs";

export default defineConfig({
  plugins: [react(), versionStoragePlugin(), agentGatewayPlugin()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 5173, strictPort: true },
});
