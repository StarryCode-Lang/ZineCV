import { policy } from "./corpus.mjs";

export function normalize(value) {
  return String(value ?? "").normalize("NFC").replace(/\r\n?/g, "\n")
    .split("\n").map(line => line.replace(/[\t \u00a0]+/g, " ").trim()).join("\n").trim();
}

// Pre-declared policy-3 normalization for the character metric: physical line
// wrapping inserts breaks that exist in no source sentence, so transcription
// accuracy compares whitespace-insensitively (digits, punctuation and order
// still count). Field equality and paragraph correspondence keep `normalize`.
const compact = (value) => normalize(value).replace(/\s+/g, "");

// Levenshtein on code points, with O(reference length) working storage.
export function characterAccuracy(actual, expected) {
  const actualText = compact(actual), expectedText = compact(expected);
  if (actualText === expectedText) return 1;
  const left = [...actualText], right = [...expectedText];
  if (!right.length) return left.length ? 0 : 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return Math.max(0, 1 - previous[right.length] / right.length);
}

// Correspondence is separate from recognition accuracy. This threshold only
// rejects missing/ambiguous paragraph partners; policy's 99%/95% gates remain
// the acceptance thresholds for transcription. A complete deletion cannot be
// offset by correct text elsewhere in the document.
const correspondenceSimilarity = 0.60;
const maximumAlignmentCells = 4_000_000;

function editCostRow(expected, actual, expectedStart, expectedEnd, actualStart, actualEnd, reverse) {
  const width = actualEnd - actualStart;
  const row = Uint32Array.from({ length: width + 1 }, (_, index) => index);
  for (let index = 0; index < expectedEnd - expectedStart; index += 1) {
    let diagonal = row[0];
    row[0] = index + 1;
    const character = expected[reverse ? expectedEnd - index - 1 : expectedStart + index];
    for (let column = 1; column <= width; column += 1) {
      const previous = row[column];
      const counterpart = actual[reverse ? actualEnd - column : actualStart + column - 1];
      row[column] = Math.min(previous + 1, row[column - 1] + 1, diagonal + (character === counterpart ? 0 : 1));
      diagonal = previous;
    }
  }
  return row;
}

// Hirschberg recovers an exact minimum-edit path using two cost rows. Only
// bounded leaf blocks allocate traceback matrices; repeated text is aligned by
// the edit algorithm, never guessed as a unique source anchor.
function alignLinearSpace(expected, actual) {
  const operations = [];
  let maximumTracebackCells = 0, maximumRowCells = 0;
  const walk = (expectedStart, expectedEnd, actualStart, actualEnd) => {
    const height = expectedEnd - expectedStart, width = actualEnd - actualStart;
    if (!height) {
      for (let index = actualStart; index < actualEnd; index += 1) operations.push({ expected: expectedStart, actual: index, insertion: true });
      return true;
    }
    if (!width) {
      for (let index = expectedStart; index < expectedEnd; index += 1) operations.push({ expected: index, actual: null });
      return true;
    }
    const cells = (height + 1) * (width + 1);
    if (cells <= maximumAlignmentCells) {
      const block = alignEditBlock(expected.slice(expectedStart, expectedEnd), actual.slice(actualStart, actualEnd));
      maximumTracebackCells = Math.max(maximumTracebackCells, block.cells);
      for (const operation of block.operations) operations.push({ ...operation, expected: operation.expected + expectedStart,
        actual: operation.actual === null ? null : operation.actual + actualStart });
      return true;
    }
    if (height === 1) {
      let match = -1;
      for (let index = actualStart; index < actualEnd; index += 1) if (actual[index] === expected[expectedStart]) match = index;
      if (match < 0) match = actualEnd - 1;
      for (let index = actualStart; index < match; index += 1) operations.push({ expected: expectedStart, actual: index, insertion: true });
      operations.push({ expected: expectedStart, actual: match });
      for (let index = match + 1; index < actualEnd; index += 1) operations.push({ expected: expectedEnd, actual: index, insertion: true });
      return true;
    }
    if ((width + 1) * 2 > maximumAlignmentCells) return false;
    maximumRowCells = Math.max(maximumRowCells, (width + 1) * 2);
    const middle = expectedStart + Math.floor(height / 2);
    let forward = editCostRow(expected, actual, expectedStart, middle, actualStart, actualEnd, false);
    let backward = editCostRow(expected, actual, middle, expectedEnd, actualStart, actualEnd, true);
    let best = Number.POSITIVE_INFINITY, split = 0;
    for (let column = 0; column <= width; column += 1) {
      const value = forward[column] + backward[width - column];
      if (value < best) { best = value; split = column; }
    }
    // Release row references before recursing so parent rows do not accumulate.
    forward = null;
    backward = null;
    return walk(expectedStart, middle, actualStart, actualStart + split)
      && walk(middle, expectedEnd, actualStart + split, actualEnd);
  };
  if (!walk(0, expected.length, 0, actual.length)) return null;
  return { operations, cells: maximumTracebackCells, maximumRowCells, linearSpace: true };
}

function alignEditBlock(expected, actual) {
  if (expected.length === actual.length && expected.every((character, index) => character === actual[index])) {
    return { operations: expected.map((_, index) => ({ expected: index, actual: index })), cells: 0 };
  }
  const columns = actual.length + 1;
  if ((expected.length + 1) * columns > maximumAlignmentCells) {
    return alignLinearSpace(expected, actual);
  }
  const costs = new Uint32Array((expected.length + 1) * columns);
  for (let row = 0; row <= expected.length; row += 1) costs[row * columns] = row;
  for (let column = 0; column <= actual.length; column += 1) costs[column] = column;
  for (let row = 1; row <= expected.length; row += 1) {
    for (let column = 1; column <= actual.length; column += 1) {
      costs[row * columns + column] = Math.min(costs[(row - 1) * columns + column] + 1,
        costs[row * columns + column - 1] + 1,
        costs[(row - 1) * columns + column - 1] + (expected[row - 1] === actual[column - 1] ? 0 : 1));
    }
  }
  const operations = [];
  let row = expected.length, column = actual.length;
  while (row || column) {
    const cost = costs[row * columns + column];
    if (row && column && cost === costs[(row - 1) * columns + column - 1] + (expected[row - 1] === actual[column - 1] ? 0 : 1)) {
      operations.push({ expected: row - 1, actual: column - 1 });
      row -= 1; column -= 1;
    } else if (row && cost === costs[(row - 1) * columns + column] + 1) {
      operations.push({ expected: row - 1, actual: null });
      row -= 1;
    } else {
      operations.push({ expected: row, actual: column - 1, insertion: true });
      column -= 1;
    }
  }
  operations.reverse();
  return { operations, cells: (expected.length + 1) * columns };
}

function anchoredCharacterAlignment(actualText, referenceParagraphs) {
  const expected = [...referenceParagraphs.join("\n")], actual = [...actualText];
  const actualLines = new Map();
  let actualCursor = 0;
  for (const line of actualText.split("\n")) {
    const entries = actualLines.get(line) ?? [];
    entries.push({ start: actualCursor, end: actualCursor + [...line].length });
    actualLines.set(line, entries);
    actualCursor += [...line].length + 1;
  }
  const counts = new Map();
  for (const paragraph of referenceParagraphs) counts.set(paragraph, (counts.get(paragraph) ?? 0) + 1);
  let expectedCursor = 0;
  const anchors = [];
  for (const paragraph of referenceParagraphs) {
    const length = [...paragraph].length;
    const candidates = actualLines.get(paragraph) ?? [];
    // A repeated paragraph in either side is never a guessed anchor. A wrapped
    // paragraph can still be resolved by its bounded neighboring edit block.
    if (paragraph && counts.get(paragraph) === 1 && candidates.length === 1) {
      anchors.push({ expectedStart: expectedCursor, expectedEnd: expectedCursor + length,
        actualStart: candidates[0].start, actualEnd: candidates[0].end });
    }
    expectedCursor += length + 1;
  }
  for (let index = 1; index < anchors.length; index += 1) {
    if (anchors[index].actualStart < anchors[index - 1].actualEnd) {
      return { complete: false, reason: "Unique exact paragraph anchors occur out of order", operations: [], anchorCount: anchors.length };
    }
  }
  const operations = [];
  let expectedOffset = 0, actualOffset = 0, maximumUndecidedBlockCells = 0, linearSpaceBlocks = 0, maximumRowCells = 0;
  for (const anchor of [...anchors, { expectedStart: expected.length, expectedEnd: expected.length,
    actualStart: actual.length, actualEnd: actual.length }]) {
    const block = alignEditBlock(expected.slice(expectedOffset, anchor.expectedStart), actual.slice(actualOffset, anchor.actualStart));
    if (!block) return { complete: false, reason: "Linear-space alignment row budget exceeded; paragraph ownership unresolved",
      operations: [], anchorCount: anchors.length };
    maximumUndecidedBlockCells = Math.max(maximumUndecidedBlockCells, block.cells);
    maximumRowCells = Math.max(maximumRowCells, block.maximumRowCells ?? 0);
    if (block.linearSpace) linearSpaceBlocks += 1;
    for (const operation of block.operations) operations.push({ ...operation, expected: operation.expected + expectedOffset,
      actual: operation.actual === null ? null : operation.actual + actualOffset });
    for (let index = 0; index < anchor.expectedEnd - anchor.expectedStart; index += 1) {
      operations.push({ expected: anchor.expectedStart + index, actual: anchor.actualStart + index });
    }
    expectedOffset = anchor.expectedEnd;
    actualOffset = anchor.actualEnd;
  }
  return { complete: true, operations, anchorCount: anchors.length, maximumUndecidedBlockCells, linearSpaceBlocks, maximumRowCells };
}

function alignParagraphs(actualText, referenceParagraphs, pages) {
  const expected = [...referenceParagraphs.join("\n")], actual = [...actualText];
  const alignment = anchoredCharacterAlignment(actualText, referenceParagraphs);
  if (!alignment.complete) return { ...alignment, operations: undefined, paragraphs: [] };
  const owners = [];
  referenceParagraphs.forEach((paragraph, index) => {
    for (const _ of paragraph) owners.push(index);
    if (index < referenceParagraphs.length - 1) owners.push(index);
  });
  const positions = referenceParagraphs.map(() => []);
  for (const operation of alignment.operations) {
    if (operation.actual === null) continue;
    if (!operation.insertion && expected[operation.expected] === "\n" && actual[operation.actual] === "\n") continue;
    const owner = owners[Math.min(operation.expected, owners.length - 1)];
    if (owner !== undefined) positions[owner].push(operation.actual);
  }
  const paragraphs = referenceParagraphs.map((reference, index) => {
    const points = positions[index];
    const start = points.length ? points[0] : null;
    const end = points.length ? points.at(-1) + 1 : null;
    const text = start === null ? "" : normalize(actual.slice(start, end).join(""));
    const similarity = characterAccuracy(text, reference);
    const alternatives = similarity === 1 ? [] : referenceParagraphs.flatMap((candidate, other) => other !== index && candidate !== reference
      && characterAccuracy(text, candidate) > similarity + 0.000001 ? [other] : []);
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const occurrences = text ? [...actualText.matchAll(new RegExp(`(?:^|\\n)${escaped}(?=\\n|$)`, "g"))].length : 0;
    const expectedOccurrences = referenceParagraphs.filter(candidate => candidate === reference).length;
    const duplicated = occurrences > expectedOccurrences;
    const missing = !text;
    const trustworthy = !missing && similarity >= correspondenceSimilarity && !alternatives.length && !duplicated;
    return { index, page: pages[index], referenceText: reference, actualSpan: { start, end, unit: "code-points", text },
      present: actualText.includes(reference), ordered: trustworthy, similarity, correspondenceSimilarity,
      missing, duplicated, occurrences, possibleReordering: alternatives, trustworthy,
      reason: missing ? "No recovered paragraph" : similarity < correspondenceSimilarity ? "Paragraph correspondence too weak"
        : alternatives.length ? "Recovered span is closer to a different paragraph" : duplicated ? "Duplicate recovered paragraph" : null };
  });
  return { complete: true, paragraphs, anchorCount: alignment.anchorCount,
    maximumUndecidedBlockCells: alignment.maximumUndecidedBlockCells,
    linearSpaceBlocks: alignment.linearSpaceBlocks, maximumRowCells: alignment.maximumRowCells };
}

function decodeEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
    const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
}

// The product's editable fields contain sanitized rich text. This independent
// scorer only reads it; it neither renders it nor imports the product parser.
// Keep block order and link targets, rather than accepting a bag of characters.
function editableContent(html) {
  const source = String(html ?? "");
  const unsafe = /<(?:script|style|iframe|object|embed)\b/i.test(source)
    || /<[^>]*\s(?:hidden(?:\s|=|>)|aria-hidden\s*=\s*["']?true(?:[\s"'>]))/i.test(source)
    || /<[^>]*\bstyle\s*=\s*["'][^"']*\b(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\s|;|'|"))/i.test(source);
  const visible = source.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  const links = [...source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].map(match => {
    const attribute = match[1].match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return { href: decodeEntities(attribute?.[1] ?? attribute?.[2] ?? attribute?.[3] ?? ""),
      text: normalize(decodeEntities(match[2].replace(/<[^>]*>/g, ""))) };
  });
  return { text: normalize(decodeEntities(visible)), links, unsafe };
}

function scoreDestinations(sample, flattened, paragraphs) {
  const destinations = sample.truth.destinations;
  if (!Array.isArray(destinations) || !destinations.length) {
    return { complete: false, passed: false, reason: "Independent editable-body destinations are missing", comparisons: [], unexpected: [] };
  }
  const expectedByPath = new Map();
  let complete = true;
  for (const destination of destinations) {
    if (!Number.isInteger(destination.paragraphIndex) || destination.paragraphIndex < 0
      || destination.paragraphIndex >= sample.truth.paragraphs.length
      || !/^(?:[a-z]+\.\d+\.html|summary)$/.test(destination.path ?? "")
      || typeof destination.text !== "string" || !normalize(destination.text)
      || normalize(destination.text) !== normalize(sample.truth.paragraphs[destination.paragraphIndex])
      || !["mapped", "unassigned"].includes(destination.disposition)
      || destination.disposition === "unassigned" && !/^custom\.\d+\.html$/.test(destination.path)) {
      complete = false;
      continue;
    }
    const group = expectedByPath.get(destination.path) ?? [];
    group.push(destination);
    expectedByPath.set(destination.path, group);
  }
  const comparisons = [...expectedByPath.entries()].map(([path, entries]) => {
    const actual = editableContent(flattened[path]);
    const sourceParagraphs = entries.map(entry => paragraphs[entry.paragraphIndex]);
    const sourceVerified = sourceParagraphs.every(paragraph => paragraph?.trustworthy);
    const expectedText = normalize(sourceParagraphs.map(paragraph => paragraph?.actualSpan.text ?? "").join("\n"));
    const expectedLinks = entries.flatMap(entry => (entry.links ?? []).map(link => ({ href: link.href,
      text: normalize(link.text) === normalize(entry.text)
        ? paragraphs[entry.paragraphIndex]?.actualSpan.text ?? "" : normalize(link.text) })));
    return { path, paragraphs: entries.map(entry => entry.paragraphIndex), expectedText,
      referenceText: entries.map(entry => entry.text).join("\n"), sourceVerified,
      actualText: actual.text, expectedLinks, actualLinks: actual.links,
      exact: sourceVerified && actual.text === expectedText && JSON.stringify(actual.links) === JSON.stringify(expectedLinks) && !actual.unsafe,
      unsafe: actual.unsafe, disposition: entries[0].disposition };
  });
  // An otherwise correct extraction must fail if it duplicates or misroutes
  // body content into any other editable module (including summary/custom).
  const unexpected = Object.entries(flattened)
    .filter(([path]) => /(?:\.html$|^summary$)/.test(path) && !expectedByPath.has(path))
    .map(([path, html]) => ({ path, ...editableContent(html) }))
    .filter(content => content.text || content.links.length || content.unsafe);
  return { complete, passed: complete && comparisons.every(comparison => comparison.exact) && !unexpected.length,
    comparisons, unexpected };
}

export function scoreSample(sample, observed) {
  const text = normalize(observed.extractedText);
  const expected = sample.truth.paragraphs.map(normalize);
  const alignment = alignParagraphs(text, expected, sample.truth.paragraphPages);
  const paragraphs = alignment.paragraphs;
  const flattened = {};
  const visit = (value, prefix = "") => {
    if (value == null) return;
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, prefix ? `${prefix}.${key}` : key);
    } else if (typeof value === "string" && value.trim()) flattened[prefix] = normalize(value);
  };
  visit(observed.resume ?? {});
  // Compare all semantic scalar fields, including unexpected non-empty fields.
  // IDs/HTML are checked separately, never true positives.
  const eligible = key => /^basic\.(name|phone|email|website|birth|ethnicity|city|wechat)$/.test(key)
    || /^(education|work|skills|projects|orgs|research|awards|other|portfolio|custom)\.\d+\.(title|role|department|city|start|end)$/.test(key);
  const actual = Object.fromEntries(Object.entries(flattened).filter(([key]) => eligible(key)));
  const fields = Object.entries(sample.truth.fields).map(([key, value]) => ({ key, expected: value,
    actual: actual[key] ?? "", exact: actual[key] === normalize(value), critical: sample.truth.critical.includes(key) }));
  const truePositives = fields.filter(field => field.exact).length;
  const precision = Object.keys(actual).length ? truePositives / Object.keys(actual).length : 0;
  const recall = truePositives / fields.length;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const counts = Object.fromEntries(Object.keys(sample.truth.entryCounts).map(key => [key, observed.resume?.[key]?.length ?? 0]));
  const structure = Object.entries(sample.truth.entryCounts).every(([key, count]) => counts[key] === count)
    && JSON.stringify((observed.moduleOrder ?? []).filter(key => sample.truth.sections.includes(key))) === JSON.stringify(sample.truth.sections);
  const accuracy = characterAccuracy(text, expected.join("\n"));
  const destinations = scoreDestinations(sample, flattened, paragraphs);
  const threshold = sample.textLayer === "none" || sample.textLayer === "mixed" ? policy.ocrAccuracy : policy.textAccuracy;
  const passed = !observed.error && accuracy >= threshold && f1 >= policy.fieldF1
    && fields.filter(field => field.critical).every(field => field.exact)
    && alignment.complete && paragraphs.every(paragraph => paragraph.trustworthy) && structure && destinations.passed;
  return { id: sample.id, family: sample.family, group: sample.group, support: sample.support,
    outcome: observed.error ? "异常失败" : passed ? "内容与结构通过" : "需校正",
    accuracy, threshold, fields: { precision, recall, f1, comparisons: fields,
      unexpected: Object.entries(actual).filter(([key]) => !(key in sample.truth.fields)) },
    paragraphs, alignment: { complete: alignment.complete, reason: alignment.reason ?? null,
      strategy: "unique-exact-paragraph-anchors-with-hirschberg", anchorCount: alignment.anchorCount,
      linearSpaceBlocks: alignment.linearSpaceBlocks ?? 0, maximumRowCells: alignment.maximumRowCells ?? null,
      maximumUndecidedBlockCells: alignment.maximumUndecidedBlockCells ?? null, maximumAlignmentCells },
    entryCounts: counts, structure, destinations, passed,
    criticalCoverage: fields.filter(field => field.critical && field.actual).length / sample.truth.critical.length,
    criticalExact: fields.filter(field => field.critical && field.exact).length / sample.truth.critical.length,
  };
}
