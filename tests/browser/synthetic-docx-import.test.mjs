import { test } from "node:test";
import { strict as assert } from "node:assert";
import { deflateRawSync } from "node:zlib";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function syntheticDocx() {
  const entries = [
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Resume</w:t></w:r></w:p><w:p><w:r><w:t>Experience candidate text 2020</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`],
  ].map(([name, text]) => {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(text, "utf8");
    const compressed = deflateRawSync(raw);
    return { nameBytes, raw, compressed, crc: crc32(raw) };
  });

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressed.length, 18);
    local.writeUInt32LE(entry.raw.length, 22);
    local.writeUInt16LE(entry.nameBytes.length, 26);
    localParts.push(local, entry.nameBytes, entry.compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressed.length, 20);
    central.writeUInt32LE(entry.raw.length, 24);
    central.writeUInt16LE(entry.nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, entry.nameBytes);
    offset += local.length + entry.nameBytes.length + entry.compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

test("synthetic DOCX parses in a worker and renders only inside the sandboxed preview", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const server = await createBrowserTestServer(root);
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await context.newPage();
    const externalRequests = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(origin)) externalRequests.push(request.url());
    });
    await page.goto(`${origin}/__zinecv_browser_test_page.html`, { waitUntil: "commit" });
    const encodedDocx = syntheticDocx().toString("base64");
    const result = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const file = new File([bytes], "synthetic-resume.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      const { recognizeTemplate } = await import(
        "/src/ui/services/template-import.ts"
      );
      const createdFrames = [];
      const originalCreateElement = document.createElement.bind(document);
      document.createElement = (tagName, options) => {
        const element = originalCreateElement(tagName, options);
        if (tagName.toLowerCase() === "iframe") {
          const evidence = { element, csp: undefined };
          element.addEventListener("load", () => {
            evidence.csp = element.contentDocument?.querySelector(
              'meta[http-equiv="Content-Security-Policy"]',
            )?.getAttribute("content");
          }, { once: true });
          createdFrames.push(evidence);
        }
        return element;
      };
      let template;
      try {
        template = await recognizeTemplate(file);
      } finally {
        document.createElement = originalCreateElement;
      }
      return {
        template,
        frames: createdFrames.map(({ element, csp }) => ({
          sandbox: element.getAttribute("sandbox"),
          csp,
          disposed: !element.isConnected,
        })),
      };
    }, encodedDocx);
    assert.match(result.template.extractedText, /Synthetic Resume/);
    assert.match(result.template.extractedText, /Experience candidate text 2020/);
    assert.match(result.template.previewDataUrl, /^data:image\/jpeg;base64,/);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].sandbox, "allow-same-origin");
    assert.match(result.frames[0].csp, /default-src 'none'/);
    assert.equal(result.frames[0].disposed, true);
    assert.deepEqual(externalRequests, []);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
