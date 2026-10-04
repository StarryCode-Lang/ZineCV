import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Captured from real render_document_export bundle on an isolated synthetic
// document. Regenerate through R16 capture.mjs; never synthesize a PDF in JS.
const defaultFixture = resolve(import.meta.dirname, '../fixtures/export-pdf-structure.bundle.json.gz');
const fixturePath = process.env.ZINECV_PDF_STRUCTURE_BUNDLE ?? defaultFixture;
const encoded = await readFile(fixturePath);
const fixture = JSON.parse((fixturePath.endsWith('.gz') ? gunzipSync(encoded) : encoded).toString('utf8'));
const data = fixture.data;
const pdfBytes = Buffer.from(data.pdfBase64, 'base64');

// TextMap intentionally excludes decorative iconfont glyphs; whitespace is a
// layout decision (line wraps and word spacing), not a semantic text change.
// Do not normalize punctuation, casing, digits, or paragraph order.
const semanticText = text => text.replace(/[\s\uE000-\uF8FF]/gu, '');

async function extract() {
  const task = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: false });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: true });
      const tree = await page.getStructTree();
      const annotations = await page.getAnnotations();
      const markedText = new Map();
      const stack = [];
      for (const item of content.items) {
        if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') stack.push(item.id);
        else if (item.type === 'endMarkedContent') stack.pop();
        else if ('str' in item) {
          for (const id of stack.filter(Boolean)) markedText.set(id, (markedText.get(id) ?? '') + item.str);
        }
      }
      const treeContent = [];
      const treeAnnotations = [];
      const roles = new Set();
      function visit(node) {
        if (!node) return;
        if (node.role) roles.add(node.role);
        if (node.type === 'content') treeContent.push(node.id);
        if (node.type === 'annotation') treeAnnotations.push(node.id);
        for (const child of node.children ?? []) visit(child);
      }
      visit(tree);
      pages.push({ pageNumber, tree, roles, treeContent, treeAnnotations, markedText, annotations,
        text: content.items.filter(item => 'str' in item).map(item => item.str).join(''),
        structuredText: treeContent.map(id => markedText.get(id) ?? '').join(''),
      });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

test('real bundle PDF preserves semantic text, page order, links and tagged reading order', async () => {
  assert.match(fixture.origin, /real release render_document_export bundle/);
  assert.equal(createHash('sha256').update(pdfBytes).digest('hex'), data.pdfSha256);
  assert.equal(data.textMap.version, 1);
  assert.ok(data.pageCount >= 2, 'fixture must exercise a real page boundary');
  assert.ok(data.textMap.links.length > 0, 'fixture must contain real links');
  assert.doesNotMatch(data.textMap.logicalText, /[\uE000-\uF8FF]/u, 'icon exclusion must not hide semantic PUA text');
  const pages = await extract();
  assert.equal(pages.length, data.pageCount);
  const expected = semanticText(data.textMap.logicalText);
  assert.equal(semanticText(pages.map(page => page.text).join('')), expected, 'PDF content stream reading order differs from TextMap');
  assert.equal(semanticText(pages.map(page => page.structuredText).join('')), expected, 'tagged reading order differs from TextMap');
  for (const page of pages) {
    assert.ok(page.tree, `page ${page.pageNumber} has no tagged structure tree`);
    assert.ok(page.roles.has('Document'));
    assert.ok(page.roles.has('P'));
    assert.ok(page.roles.has('Link'));
    assert.ok(page.treeContent.length > 0);
    for (const id of page.treeContent) assert.ok(page.markedText.has(id), `tag ${id} has no actual text content`);
    const clusters = data.textMap.clusters.filter(cluster => cluster.page === page.pageNumber);
    const logicalPage = clusters.map(cluster => data.textMap.logicalText.slice(cluster.startUtf16, cluster.endUtf16)).join('');
    assert.equal(semanticText(page.text), semanticText(logicalPage), `page ${page.pageNumber} text does not match its TextMap clusters`);
    const expectedLinks = data.textMap.links.filter(link => clusters.some(cluster =>
      cluster.sourceNodeId === link.sourceNodeId && cluster.endUtf16 > link.startUtf16 && cluster.startUtf16 < link.endUtf16));
    const actualLinks = page.annotations.filter(annotation => annotation.subtype === 'Link');
    assert.equal(actualLinks.length, expectedLinks.length, `page ${page.pageNumber} link count`);
    assert.deepEqual(actualLinks.map(annotation => annotation.url), expectedLinks.map(link => link.href));
    assert.deepEqual(actualLinks.map(annotation => semanticText(annotation.overlaidText)),
      expectedLinks.map(link => semanticText(data.textMap.logicalText.slice(link.startUtf16, link.endUtf16))));
    for (const annotation of actualLinks) {
      assert.ok(page.treeAnnotations.includes(`pdfjs_internal_id_${annotation.id}`), `link ${annotation.id} is absent from the structure tree`);
      assert.ok(Number.isInteger(annotation.structParent));
    }
  }
});
