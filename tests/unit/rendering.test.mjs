import { test } from "node:test";
import { strict as assert } from "node:assert";
import { EngineFitClient } from "../../src/preview/engineFit.ts";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfLines } from "../../src/ui/services/pdf-reading-order.ts";

// engine-fit
{
  const cursor = { documentId: "doc", contextId: "ctx", revision: "1", branchId: "main", headId: null };
  const presentation = { templateId: "baseline", templateRevision: "1", fontSetId: "frozen", density: "comfortable", theme: "blue",
    fontSizePt: 11, lineHeightPt: 14, headingSizePt: 13, pageMarginPt: 22, moduleGapPt: 2, paragraphGapPt: 1, listGapPt: 1, legacyOverrides: {} };
  function proposal(current = cursor) {
    return { cursor: structuredClone(current), renderKey: "a".repeat(64), plan: {
      status: "fitted", semanticHash: "b".repeat(64), originalPresentation: structuredClone(presentation),
      fittedPresentation: { ...structuredClone(presentation), fontSizePt: 10, lineHeightPt: 12 },
      attempts: [{ candidateIndex: 0, pageCount: 2 }, { candidateIndex: 1, pageCount: 1 }],
    } };
  }

  test("fit coalesces requests and cancellation discards late success or failure", async () => {
    const calls = [];
    const releases = [];
    const client = new EngineFitClient((command, args) => {
      calls.push({ command, args });
      return new Promise((resolve, reject) => releases.push({ resolve, reject }));
    });
    const first = client.request(cursor);
    const superseded = client.request({ ...cursor, revision: "2" });
    const newestCursor = { ...cursor, revision: "3" };
    const newest = client.request(newestCursor);
    assert.equal(await superseded, null);
    assert.equal(calls.length, 1);
    releases[0].resolve(proposal(cursor));
    assert.equal(await first, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args.cursor, newestCursor);
    client.cancel();
    releases[1].reject(new Error("late worker failure"));
    assert.equal(await newest, null);
    assert.equal(calls.length, 2);
  });

  test("fit application uses the full frozen CAS once and rejects cancelled or changed contexts", async () => {
    const commits = [];
    const client = new EngineFitClient(async (command, args) => {
      if (command === "fit_document_one_page") return proposal(args.cursor);
      commits.push(args.envelope);
      return { durable: true };
    }, () => "fit-command");
    const planned = await client.request(cursor);
    assert.equal(await client.apply(planned, { ...cursor, contextId: "changed" }), null);
    assert.equal(commits.length, 0);
    await client.apply(planned, cursor);
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0], { protocolVersion: 1, commandId: "fit-command", documentId: cursor.documentId,
      contextId: cursor.contextId, expectedRevision: cursor.revision, expectedBranchId: cursor.branchId,
      expectedHeadId: cursor.headId, payload: { type: "setLayout", presentation: planned.plan.fittedPresentation } });
    assert.equal(await client.apply(planned, cursor), null);
    const cancelled = await client.request(cursor);
    client.cancel();
    assert.equal(await client.apply(cancelled, cursor), null);
    assert.equal(commits.length, 1);
  });

  test("fit rejects cursor mismatch, unreadable layouts and protected-field changes before application", async () => {
    for (const mutate of [
      result => { result.cursor.headId = "different-head"; },
      result => { result.plan.fittedPresentation.fontSizePt = 8; },
      result => { result.plan.fittedPresentation.fontSetId = "different-font"; },
      result => { result.plan.attempts[1].candidateIndex = 16; },
    ]) {
      const result = proposal();
      mutate(result);
      const client = new EngineFitClient(async () => result);
      await assert.rejects(client.request(cursor));
    }
    let commits = 0;
    const result = proposal();
    result.plan.status = "timedOut";
    result.plan.fittedPresentation = null;
    const client = new EngineFitClient(async command => { if (command === "fit_document_one_page") return result; commits++; });
    const planned = await client.request(cursor);
    assert.equal(await client.apply(planned, cursor), null);
    assert.equal(commits, 0);
  });
}

// export-pdf-structure
{
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
}

// pdf-reading-order
{
  const line=(text,x,y,width=100)=>({text,x,y,width,fontSize:12});

  test("short two-column PDF reads a whole left column before the right, including rows above the old 70% cutoff",()=>{
   const input=[line("Header",50,740,420),...Array.from({length:4},(_,index)=>[line("LEFT "+index,50,680-index*24),line("RIGHT "+index,320,680-index*24)]).flat()];
   assert.deepEqual(pdfLines(input,2,612).map(line=>line.text),["Header","LEFT 0","LEFT 1","LEFT 2","LEFT 3","RIGHT 0","RIGHT 1","RIGHT 2","RIGHT 3"]);
   assert.ok(pdfLines(input,2,612).every(line=>line.page===2));
  });
  test("full-width headings reset column order without duplicating or dropping text",()=>{
   const input=[line("Header",50,740,420),...Array.from({length:4},(_,index)=>[line("A LEFT "+index,50,680-index*24),line("A RIGHT "+index,320,680-index*24)]).flat(),line("Second band",50,540,420),...Array.from({length:4},(_,index)=>[line("B LEFT "+index,50,500-index*24),line("B RIGHT "+index,320,500-index*24)]).flat()];
   assert.deepEqual(pdfLines(input,1,612).map(line=>line.text),["Header",...Array.from({length:4},(_,i)=>"A LEFT "+i),...Array.from({length:4},(_,i)=>"A RIGHT "+i),"Second band",...Array.from({length:4},(_,i)=>"B LEFT "+i),...Array.from({length:4},(_,i)=>"B RIGHT "+i)]);
  });
  test("single-column fragments and occasional right-aligned dates retain row order",()=>{
   const input=[line("Title",50,740,420),line("Work",50,680,200),line("2024",400,680,50),line("Body",50,656,480),line("Education",50,620,200),line("2020",400,620,50),line("Details",50,596,480)];
   assert.deepEqual(pdfLines(input,1,612).map(line=>line.text),["Title","Work 2024","Body","Education 2020","Details"]);
   const fragments=[line("Name",50,700,35),line("Surname",95,700,50),line("Plain text",50,680,200)];
   assert.deepEqual(pdfLines(fragments,1,612).map(line=>line.text),["Name Surname","Plain text"]);
  });
}
