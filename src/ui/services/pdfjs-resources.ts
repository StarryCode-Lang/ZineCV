export function localPdfJsResourceOptions(baseHref: string) {
  const base = new URL("/pdfjs/", baseHref);
  return {
    cMapUrl: new URL("cmaps/", base).href,
    cMapPacked: true,
    iccUrl: new URL("iccs/", base).href,
    standardFontDataUrl: new URL("standard_fonts/", base).href,
    wasmUrl: new URL("wasm/", base).href,
  };
}
