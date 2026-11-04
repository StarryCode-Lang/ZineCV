import type { ExportPng } from "../../../src-tauri/src/domain/bindings/ExportPng";

const MAX_SELECTED_PIXELS = 64_000_000;
const MAX_LONG_PIXELS = 32_000_000;
const MAX_ENCODED_BYTES = 48 * 1024 * 1024;

async function encode(canvas: HTMLCanvasElement, page: number): Promise<{ image: ExportPng; bytes: number }> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    value => value ? resolve(value) : reject(new Error("无法生成 PNG 图片")), "image/png",
  ));
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("PNG 编码失败"));
    reader.onerror = () => reject(new Error("PNG 编码失败"));
    reader.readAsDataURL(blob);
  });
  return { image: { page, width: canvas.width, height: canvas.height, sha256, dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) }, bytes: blob.size };
}

/** Build checked page and long-image artifacts with the same budgets as native export. */
export async function encodeSourceLayoutPng(canvases: HTMLCanvasElement[]): Promise<{
  pngPages: ExportPng[]; longPng: ExportPng | null; longImageLimited: boolean;
}> {
  if (!canvases.length || canvases.length > 50 || canvases.some(canvas => !canvas.width || !canvas.height)) {
    throw new Error("原版式 PNG 页面无效");
  }
  const totalPixels = canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0);
  if (totalPixels > MAX_SELECTED_PIXELS) throw new Error("原版式 PNG 页面超过像素上限");
  const width = Math.max(...canvases.map(canvas => canvas.width));
  const height = canvases.reduce((sum, canvas) => sum + canvas.height, 0);
  const longImageLimited = width * height > MAX_LONG_PIXELS || height > 32_768;
  const pngPages: ExportPng[] = [];
  let bytes = 0;
  for (const [index, canvas] of canvases.entries()) {
    const encoded = await encode(canvas, index + 1);
    bytes += encoded.bytes;
    if (bytes > MAX_ENCODED_BYTES) throw new Error("原版式 PNG 超过大小上限");
    pngPages.push(encoded.image);
  }
  let longPng: ExportPng | null = null;
  if (!longImageLimited) {
    const long = document.createElement("canvas");
    long.width = width; long.height = height;
    try {
      const context = long.getContext("2d");
      if (!context) throw new Error("无法生成 PNG 长图");
      context.fillStyle = "#fff"; context.fillRect(0, 0, width, height);
      let y = 0;
      for (const canvas of canvases) { context.drawImage(canvas, 0, y); y += canvas.height; }
      const encoded = await encode(long, 0);
      if (bytes + encoded.bytes > MAX_ENCODED_BYTES) throw new Error("原版式 PNG 超过大小上限");
      longPng = encoded.image;
    } finally { long.width = 0; long.height = 0; }
  }
  return { pngPages, longPng, longImageLimited };
}
