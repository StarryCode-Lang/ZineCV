// Isolated architecture experiment. This database is never the product database.
import sqlite3InitModule from "../../../node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs";
import initCore, { DomainSession, default_document, sqlite_sync_probe, preview, export_pdf } from "../../../.artifacts/wasm-bindings/zinecv_wasm.js";

let core;
let pool;
let database;
let session;
const exec = sql => database.exec({ sql, rowMode: "object", returnValue: "resultRows" });

async function handle({ action, directory, json, envelope }) {
  if (action === "open") {
    core ??= await initCore();
    const sqlite = await sqlite3InitModule();
    pool = await sqlite.installOpfsSAHPoolVfs({
      name: "zinecv-architecture-poc", directory, initialCapacity: 12,
    });
    database = new pool.OpfsSAHPoolDb("/poc.sqlite3", "c");
    sqlite_sync_probe(exec, "CREATE TABLE IF NOT EXISTS poc_documents(id TEXT PRIMARY KEY, json TEXT NOT NULL)");
    const rows = sqlite_sync_probe(exec, "SELECT json FROM poc_documents WHERE id='document'");
    session = new DomainSession(rows[0]?.json ?? default_document("poc-document"));
    return { version: sqlite.version.libVersion, persisted: rows.length === 1,
      document: JSON.parse(session.snapshot()), cursor: JSON.parse(session.cursor("poc-context")),
      crossOriginIsolated, opfs: !!navigator.storage?.getDirectory,
      synchronous: !Array.isArray(rows) ? false : true };
  }
  if (action === "edit") {
    const result = JSON.parse(session.apply("poc-actor", "poc-context", JSON.stringify(envelope)));
    database.exec({ sql: "INSERT INTO poc_documents VALUES ('document', ?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      bind: [session.snapshot()] });
    return { result, document: JSON.parse(session.snapshot()) };
  }
  if (action === "rollback-crash") {
    sqlite_sync_probe(exec, "BEGIN IMMEDIATE");
    database.exec({ sql: "UPDATE poc_documents SET json=?1 WHERE id='document'", bind: ["uncommitted invalid document"] });
    return { uncommitted: true };
  }
  if (action === "promise-rejected") {
    try { sqlite_sync_probe(() => Promise.resolve([]), "SELECT 1"); }
    catch (error) { return { rejected: true, message: String(error) }; }
    return { rejected: false };
  }
  if (action === "render") {
    const value = json ?? session.snapshot();
    return { preview: JSON.parse(preview(value)), pdf: Array.from(export_pdf(value)) };
  }
  if (action === "close") {
    session?.free();
    database?.close();
    await pool?.pauseVfs();
    return { closed: true };
  }
  throw new Error("Unknown POC action");
}

self.onmessage = async event => {
  try { self.postMessage({ id: event.data.id, result: await handle(event.data) }); }
  catch (error) { self.postMessage({ id: event.data.id, error: String(error), stack: error?.stack }); }
};
