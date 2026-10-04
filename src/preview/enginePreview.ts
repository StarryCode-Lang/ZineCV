import type { AuthorityCursor } from "../../src-tauri/src/domain/bindings/AuthorityCursor";
import type { PreviewPage } from "../../src-tauri/src/domain/bindings/PreviewPage";
import type { PreviewResult } from "../../src-tauri/src/domain/bindings/PreviewResult";
import { nativeInvoke, type NativeInvoke } from "../platform/ipc";

const hashPattern = /^[a-f0-9]{64}$/;
const cursorKeys = ["documentId", "contextId", "revision", "branchId", "headId"] as const;
const sameCursor = (a: AuthorityCursor, b: AuthorityCursor) => cursorKeys.every((key) => a[key] === b[key]);

export async function verifyPreview(result: PreviewResult, cursor: AuthorityCursor): Promise<void> {
  if (!sameCursor(result.cursor, cursor) || !hashPattern.test(result.renderKey)
      || !result.data.pages.length || result.data.pages.length > 200) {
    throw new Error("Engine preview does not match the frozen document");
  }
  const units = result.data.textMap.logicalText.length;
  if (result.data.textMap.version !== 1) throw new Error("Unsupported engine text map");
  const validFragment = (fragment: { page: number; startUtf16: number; endUtf16: number; xPt: number; yPt: number; widthPt: number; heightPt: number }) =>
    [fragment.page, fragment.startUtf16, fragment.endUtf16].every(Number.isInteger)
    && fragment.page >= 1 && fragment.page <= result.data.pages.length && fragment.startUtf16 >= 0
    && fragment.startUtf16 < fragment.endUtf16 && fragment.endUtf16 <= units
    && [fragment.xPt, fragment.yPt, fragment.widthPt, fragment.heightPt].every(Number.isFinite)
    && fragment.widthPt >= 0 && fragment.heightPt > 0;
  if (result.data.pages.reduce((sum, page) => sum + new TextEncoder().encode(page.svg).length, 0) > 48 * 1024 * 1024) {
    throw new Error("Engine preview exceeds the resource limit");
  }
  for (const cluster of result.data.textMap.clusters) {
    if (!validFragment(cluster) || (cluster.rtl !== undefined && typeof cluster.rtl !== "boolean")) throw new Error("Invalid engine text cluster");
  }
  const regionIds = new Set<string>();
  for (const region of result.data.textMap.hitRegions) {
    if (!region.sourceNodeId || regionIds.has(region.sourceNodeId) || !Number.isInteger(region.semanticOrder)
        || region.semanticOrder < 0 || !region.fragments.length || !region.fragments.every(validFragment)) throw new Error("Invalid engine hit region");
    regionIds.add(region.sourceNodeId);
  }
  for (const link of result.data.textMap.links ?? []) {
    let safe = false;
    try {
      const url = new URL(link.href);
      safe = ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password && !/[\u0000-\u0020]/.test(link.href);
    } catch { /* malformed destinations are rejected below */ }
    if (!safe || !link.sourceNodeId || ![link.startUtf16, link.endUtf16].every(Number.isInteger)
        || link.startUtf16 < 0 || link.startUtf16 >= link.endUtf16 || link.endUtf16 > units
        || !result.data.textMap.clusters.some((cluster) => cluster.sourceNodeId === link.sourceNodeId
          && cluster.startUtf16 >= link.startUtf16 && cluster.endUtf16 <= link.endUtf16)) throw new Error("Invalid engine text link");
  }
  for (const page of result.data.pages) {
    if (!hashPattern.test(page.pageHash) || !Number.isFinite(page.widthPt) || !Number.isFinite(page.heightPt)
        || page.widthPt <= 0 || page.heightPt <= 0) throw new Error("Invalid engine page");
    const bytes = new TextEncoder().encode(page.svg);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== page.pageHash) throw new Error("Engine page hash mismatch");
    const tree = new DOMParser().parseFromString(page.svg, "image/svg+xml");
    if (tree.querySelector("parsererror") || tree.documentElement.localName !== "svg") throw new Error("Invalid engine SVG");
    for (const node of tree.querySelectorAll("*")) {
      if (["script", "foreignObject", "iframe", "object", "embed", "style"].includes(node.localName)) throw new Error("Unsafe engine SVG element");
      for (const attribute of node.attributes) {
        const value = attribute.value.trim();
        if (attribute.localName.toLowerCase().startsWith("on") || /url\(\s*['"]?(?!#)/i.test(value)) throw new Error("Unsafe engine SVG attribute");
        if (["href", "src"].includes(attribute.localName) && !value.startsWith("#")
            && !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value)
            && !(node.localName === "a" && /^(https?:\/\/|mailto:)/i.test(value))) throw new Error("External engine SVG resource");
      }
    }
  }
}

type CachedPage = { page: PreviewPage; url: string; bytes: number; users: number; lastUse: number };
export type PageLease = { page: PreviewPage; url: string; release: () => void };

/** Only verified SVG bytes enter this cache. Active views pin their object URLs. */
export class EnginePageCache {
  private readonly pages = new Map<string, CachedPage>();
  private clock = 0;
  constructor(private readonly byteBudget = 16 * 1024 * 1024, private readonly pageBudget = 32) {}

  acquire(page: PreviewPage): PageLease {
    let entry = this.pages.get(page.pageHash);
    if (entry && (entry.page.svg !== page.svg || entry.page.widthPt !== page.widthPt || entry.page.heightPt !== page.heightPt)) {
      throw new Error("Conflicting engine page identity");
    }
    if (!entry) {
      const blob = new Blob([page.svg], { type: "image/svg+xml" });
      entry = { page, url: URL.createObjectURL(blob), bytes: blob.size, users: 0, lastUse: 0 };
      this.pages.set(page.pageHash, entry);
    }
    entry.users += 1;
    entry.lastUse = ++this.clock;
    this.prune();
    let released = false;
    return { page: entry.page, url: entry.url, release: () => {
      if (released) return;
      released = true;
      entry.users -= 1;
      this.prune();
    } };
  }

  private prune() {
    let bytes = [...this.pages.values()].reduce((sum, page) => sum + page.bytes, 0);
    const candidates = [...this.pages.entries()].filter(([, page]) => page.users === 0)
      .sort(([, a], [, b]) => a.lastUse - b.lastUse);
    for (const [hash, page] of candidates) {
      if (bytes <= this.byteBudget && this.pages.size <= this.pageBudget) break;
      URL.revokeObjectURL(page.url);
      this.pages.delete(hash);
      bytes -= page.bytes;
    }
  }

  dispose() {
    for (const page of this.pages.values()) URL.revokeObjectURL(page.url);
    this.pages.clear();
  }
}

/** A late render can never replace a newer editing cursor or preview request. */
export class EnginePreviewClient {
  private epoch = 0;
  private active = false;
  private pending: { cursor: AuthorityCursor; epoch: number; resolve: (result: PreviewResult | null) => void; reject: (error: unknown) => void } | null = null;
  constructor(private readonly invoke: NativeInvoke = nativeInvoke) {}
  invalidate() {
    this.epoch += 1;
    this.pending?.resolve(null);
    this.pending = null;
  }
  request(cursor: AuthorityCursor): Promise<PreviewResult | null> {
    this.pending?.resolve(null);
    const epoch = ++this.epoch;
    return new Promise((resolve, reject) => {
      this.pending = { cursor: structuredClone(cursor), epoch, resolve, reject };
      void this.pump();
    });
  }
  private async pump() {
    if (this.active || !this.pending) return;
    const request = this.pending;
    this.pending = null;
    this.active = true;
    try {
      const result = await this.invoke("render_document_preview", { cursor: request.cursor }) as PreviewResult;
      if (request.epoch !== this.epoch) request.resolve(null);
      else {
        await verifyPreview(result, request.cursor);
        request.resolve(request.epoch === this.epoch ? result : null);
      }
    } catch (error) {
      if (request.epoch !== this.epoch) request.resolve(null);
      else request.reject(error);
    } finally {
      this.active = false;
      void this.pump();
    }
  }
}
