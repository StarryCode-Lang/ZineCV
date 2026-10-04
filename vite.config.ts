import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const pdfjsRoot = resolve(projectRoot, "node_modules/pdfjs-dist");
const pdfjsDirectories = ["cmaps", "iccs", "standard_fonts", "wasm"];

function servePdfJsAsset(
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: Error) => void,
) {
  const requestUrl = request.url ?? "";
  if (!requestUrl.startsWith("/pdfjs/")) {
    next();
    return;
  }
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(requestUrl.split("?", 1)[0].slice("/pdfjs/".length));
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (
    !relativePath ||
    relativePath.split(/[\\/]/).some((segment) => segment === ".." || segment === ".") ||
    relativePath.startsWith("/")
  ) {
    response.writeHead(403).end();
    return;
  }
  const assetPath = resolve(pdfjsRoot, relativePath);
  if (!assetPath.startsWith(`${pdfjsRoot}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  const extension = assetPath.split(".").pop()?.toLowerCase();
  const contentType = extension === "ttf"
    ? "font/ttf"
    : extension === "otf"
      ? "font/otf"
      : extension === "txt" || extension === "license"
        ? "text/plain; charset=utf-8"
        : "application/octet-stream";
  const stream = createReadStream(assetPath);
  stream.once("open", () => {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    });
  });
  stream.once("error", (error) => {
    if (response.headersSent) response.destroy(error);
    else next(error);
  });
  stream.pipe(response);
}

function pdfjsRuntimeAssets(): Plugin {
  return {
    name: "zinecv-pdfjs-runtime-assets",
    configureServer(server) {
      server.middlewares.use(servePdfJsAsset);
    },
    configurePreviewServer(server) {
      server.middlewares.use(servePdfJsAsset);
    },
    async writeBundle(outputOptions) {
      const outputDirectory = resolve(projectRoot, outputOptions.dir ?? "dist");
      const destination = resolve(outputDirectory, "pdfjs");
      await mkdir(destination, { recursive: true });
      for (const directory of pdfjsDirectories) {
        await cp(resolve(pdfjsRoot, directory), resolve(destination, directory), {
          recursive: true,
          force: true,
        });
      }
      await cp(resolve(projectRoot, "docs", "licenses"), resolve(outputDirectory, "licenses"), {
        recursive: true,
        force: true,
      });
      // Enabled only by a verified native release build. Browser/dev builds
      // retain the public font copies for their same-origin font source.
      if (process.env.ZINECV_RELEASE_FONTS === "engine") {
        if (outputDirectory !== resolve(projectRoot, "dist")) {
          throw new Error("Engine font deduplication requires the project's dist directory");
        }
        for (const file of [
          "source-han-serif-cn-regular.otf",
          "source-han-serif-cn-heavy.ttf",
          "wondercv-iconfont.ttf",
          "wondercv-iconfont.woff2",
        ]) {
          await rm(resolve(outputDirectory, "fonts", file), { force: true });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsRuntimeAssets()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/.artifacts/**"] },
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
          if (id.includes("node_modules/html2canvas/")) {
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
