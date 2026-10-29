# Public IPC contract v1

This document records the current React-to-Rust boundary. Rust types
and the registered Tauri handlers are authoritative; generated TypeScript lives
under `src-tauri/src/domain/bindings/`. `tools/verify-bindings.mjs` validates
imports and strict TypeScript types without a historical hash manifest. Rust
remains the schema source; regeneration is preferred for durable schema changes.

## Active host contract

- `write_clipboard_text({ text })` is main-window-only. Windows writes bounded,
  NUL-free UTF-16 text through the OS clipboard API and returns true only after
  `SetClipboardData` succeeds; contention returns a structured permission error.
  Other hosts return false to retain the existing browser fallback. It never
  reads clipboard contents or changes document state.

- `version_graph_detailed` returns all visible commit metadata while materializing
  at most 1000 snapshots (plus the current branch head). An empty `snapshotDocumentJson`
  means the snapshot must be fetched on demand, never an empty resume.
  `version_commit_detail({ commitId })` is available only to the main window;
  the host fixes the document ID and returns one `VersionCommitDetailed` or
  structured `NOT_FOUND`. Detail reads use the same visible commit links and
  deleted-origin semantics as the graph. Version selection, loading, comparison,
  references and JSON backup hydrate missing snapshots before consuming them.

- The current document mutation envelope is `CommandEnvelope` with protocol
  version 1. Its envelope fields use camel case. `DomainCommand` variants use
  camel-case `type` tags while their variant fields retain the existing
  snake-case wire names; this is an intentional compatibility contract.
- The registered command-name union is Rust-generated as
  `NativeIpcCommandName`. `verify:contracts` requires exact equality among this
  union, `generate_handler!`, and the `main` window capability list.
- Document editing uses the active document and editing context. Imported
  template contexts have stable host-derived IDs and independent durable drafts.
  Tauri injects the `main` window and active session. The host derives actor ID
  from the validated account session or uses `local-anonymous`; callers cannot
  supply actor, account, or window IDs. Account identity does not partition
  resume documents.
- M2 activeDocument: the host keeps a process-level active document with a
  monotonically increasing epoch. Every document-scoped command (saves,
  versions, imports, proposals, fit/preview/export initiation, avatar writes,
  agent targets) must target the active document; a mismatch is a structured
  `CONFLICT` ("目标文档已不是当前文档") and is not retryable. Frozen exports
  that were initiated before a switch still complete and must be labelled with
  their original target. Import drafts are persistently bound to
  `targetDocumentId` (required on `create_import_draft`); `apply_import`
  requires the bound document, the active document, and the request cursor to
  agree. `restore_database_backup` and `replace_version_store` advance the
  epoch. Switching invalidates the departing document cursor in the same
  transaction as the active setting. Restore advances every candidate document
  revision beyond both backup and live revisions before publication; its active
  setting must name an unarchived document (otherwise the first available one
  is selected in the candidate). A candidate with no available document fails
  without replacing the live database.
- M2 new commands (10): `document_list` `{ includeArchived }` →
  `DocumentListResult`; `document_create` (`CreateDocumentRequest`:
  blank or duplicate payload, `expectedCurrentId`, `expectedEpoch`) →
  `CreateDocumentResult` (`receipt` with stable command/document identities and
  nullable `activeState`). The initial create, departure revision, active setting
  and receipt commit atomically. Identical retries never create again or reclaim
  active selection; `activeState` is null when the user has already left that
  document. `document_archive`/`document_restore`
  (`ArchiveDocumentRequest`-shaped, expected-state guarded with durable receipts) →
  `DocumentListResult`; `switch_active_document`
  (`SwitchActiveDocumentRequest` with `expectedEpoch`) →
  `SwitchActiveDocumentResult`; `job_material_save`
  (`UpsertJobMaterialRequest`, revision-preserving with `expectedEpoch`) → `JobMaterial`;
  `job_material_list` `{ documentId }` → `JobMaterialListResult` with `materials`,
  `links`, and only the historical `revisions` referenced by those links;
  `job_material_delete`/`job_material_unlink` take typed requests containing
  `commandId`, `documentId`, `expectedEpoch` and the material/link ID;
  `job_material_link` (`LinkJobMaterialRequest`, records the job-material
  revision and validating the full authority cursor) → `DocumentJobLink`.
  All job writes use atomic receipts; replay does not repeat later superseded
  effects. Material ownership and revision history are read from SQLite rather
  than trusted from renderer content. Import creation also captures `expectedEpoch`
  before hashing/recognition. `document_state` additionally returns
  `meta` and `epoch`. Archiving never deletes drafts, commits, snapshots,
  proposals or resources; the active document cannot be archived.
- IPC failures are structured `AppError` values: `code`, `message`,
  `retryable`, and unique `diagnosticId`. Storage errors preserve Conflict,
  NotFound, Permission, StorageFull, StorageCorrupt, and UnsupportedSchema
  categories. Legacy/unclassified host failures use `IPC_FAILURE`.
- Browser preview does not provide native IPC. The bridge accepts only the
  generated active command-name union and wraps structured native failures in
  `NativeIpcError` after validating the error envelope.

## Preview snapshot data contract (P09)

- `render_document_preview(cursor)` freezes the authoritative document and avatar
  under the same cursor checks as PDF export. The main-window capability is
  explicit; no arbitrary source, resource path, or remote URL is accepted.
- Avatar leases remain active through worker rendering and are released on both
  success and failure. The existing isolated worker verifies immutable font,
  avatar, template, reference-date and format inputs against its render key.
- `PreviewResult` contains the frozen cursor, render key, SVG pages with SHA-256
  page hashes and physical point dimensions, and a TextMap with UTF-16 clusters
  and multi-fragment semantic hit regions. Pages and text share one compile.
- TextMap v1 additionally carries `links`: complete logical leaf IDs, UTF-16
  ranges and canonical HTTP/HTTPS/mailto destinations. Nested inline links
  retain their own destinations; basic website links use the template's HTTPS
  normalization. Rust accepts older TextMap payloads without this additive array
  as an empty array. The preview verifier rejects malformed destinations,
  credentials, dangerous protocols and ranges without corresponding glyphs.
- Text clusters additionally carry `rtl`, resolved by the same Unicode bidi
  implementation/version used by Typst, across complete logical paragraphs.
  The paragraph base direction follows the current zh/LTR templates. The flag
  reverses physical caret edges without reversing logical clipboard text.
  Older clusters without this additive flag decode as LTR. This proves neither
  font coverage nor visual glyph acceptance; the current bundled engine fonts
  lack the Hebrew characters used by the direction pipeline fixture.
- The frontend verifies cursor/page hashes and SVG resource restrictions. It
  admits one active request and the newest pending request; superseded responses
  cannot replace a newer cursor. Object URLs are reused by page hash, pinned by
  active leases, and revoked on LRU eviction or disposal.
- This data path does not enable a new default preview. The current DOM preview
  remains active while the font and geometry acceptance gate is unresolved.

## Active proposal transaction contract (R22)

- `list_agent_proposals` derives the account from the active host session and
  returns a Rust-generated `AgentProposalInbox`. `pending` contains that
  account's unexpired proposals with their durable session IDs;
  `undoable` contains confirmed receipts that have not already been undone,
  also grouped by their original session. The renderer supplies no owner,
  run, document, or scope identifiers.
- `confirm_proposal` accepts only `ConfirmProposalRequest`: an idempotency
  command ID, the current authority cursor, a host-owned proposal ID, and the
  accepted item IDs. Rust reloads the proposal under an immediate SQLite
  transaction, verifies account, expiry, document/context/revision/branch/head,
  scope hash and each before-value, then applies all accepted changes and saves
  the document, resource references, receipt and proposal status atomically.
- `reject_proposal` accepts only `RejectAgentProposalRequest`. It changes no
  resume data and stores an account-scoped idempotent receipt.
- `undo_confirmed_proposal` accepts only `UndoConfirmedProposalRequest`: a
  command ID, current cursor and the original confirmation receipt ID. Rust
  checks the current after-values and applies constrained inverse operations in
  one transaction. Renderer-supplied inverse patches are never accepted.
- Agent-generated drafts enter SQLite as `pending` only after the model run
  returns and the original run cursor, account and selected-reference scope
  still match. A failed persistence step returns an error and exposes no
  `proposal.ready` event. Model output cannot call the confirmation handlers.
- The current model tool can propose basic-field text, summary text and entry
  body text. The transaction schema is typed against `ProposalChange`; adding
  template/version mutations or new asset-producing commands requires a later
  explicit command and side-effect contract.

## Reserved inputs, not registered commands

These types describe reserved payloads, not callable handlers.

- `ApplyTemplateRequest` accepts one of the three built-in template IDs, a
  frozen cursor, an idempotent command ID, and explicit presentation fields.
  It has no arbitrary `legacyOverrides` map.
- `ApplyImportRequest` identifies a host-owned `ImportDraft` and selected
  candidate IDs. It does not accept paths, file bytes, or document/account
  ownership supplied by the webview.
- `RenderRequest` is pinned to an authority cursor and a typed PDF/PNG/SVG
  format. It carries no output path. `RenderResult` identifies the frozen
  cursor, format, page count, content hash, and returned bytes.

The request structs deny unknown top-level fields. Existing active mutation
envelopes and the `BasicPatch` also reject unlisted fields. Generated binding
files are produced by Rust `ts-rs` exports; never hand-edit them.

## Additive frozen export bundle (default format)

`render_document_export({ cursor })` freezes the authoritative draft and avatar
lease and returns `NativeExportResult`: the existing `ExportResult` fields
(complete cursor, format-bound renderKey and `ExportData`), plus a bounded host
`exportId`, frozen `source` (document/branch titles, template ID/revision/source
hash and UTC freeze time), and `artifacts` (host-verified ID, format, page, byte
length and SHA-256). PDF, all page PNGs, the bounded vertical PNG
and logical TextMap derive from one worker compile with frozen fonts/template/date.
The current bundle uses the default 192 DPI / 2 × ceil(CSS pixels) size. Each binary
has its own SHA-256; the host checks PDF signature, PNG IHDR/dimensions/order and
long-image size. The ordinary protocol envelope retains its 48 MiB output cap,
including JSON/base64 overhead. No SQLite draft is written by this command.

Optional `product: "bundle" | "pdf" | "png"`, `selectedPages: number[]` (PDF
only, one-based, sorted and deduplicated), and `dpi: number` are accepted. DPI
must be an integer from 72 through 300; absent retains 192. Invalid DPI is
rejected before allocating resources. The frozen render key binds product,
normalized page selection and effective DPI; worker validation and host output
validation check the same resolution. PNG UI offers 72/144/192/300 DPI and
retains the default vertical image, with per-page output when its budget is exceeded.

Clear-template headings may use the installed Windows Georgia or Times New Roman
regular/bold pair. The host reads only fixed filenames under the directory returned
by Windows, with a 4 MiB per-font bound; family, style, subset permission and
outline-embedding permission must pass before use. Font bytes remain outside the
application bundle. Their SHA-256 identities identify each render input in the internal resource
manifest and render key; workers revalidate the pair and keep at most one cached
buffer per fixed font role. Missing or restricted fonts produce a diagnostic and
fall back to the bundled body font. Existing bundled-font identities and resource
ownership in persisted documents are unchanged. This runtime use does not assert
permission to redistribute the system fonts or clear unrelated iconfont licensing.

### Native save delivery (P12)

Three additive commands deliver the frozen bundle to disk; they carry no
document state:

- `pick_export_path({ kind, defaultName })` shows the native save dialog
  (IFileDialog, parented to the main window) filtered to `pdf` or `png` and
  returns the picked absolute path, or `null` when the user cancels. Cancellation
  is not an error. The host sanitizes the default file name (reserved characters
  become `-`, control characters are dropped, 120-character cap).
- `pick_export_directory()` returns a picked folder for the bounded per-page
  fallback, or `null` on cancel.
- `write_export_file({ path, dataBase64, exportId?, artifactId?, writeId? })` requires an absolute path, rejects
  payloads above the 64 MiB decoded budget (`RESOURCE_LIMIT`), writes
  create/write/sync, re-reads the actual file, and reports
  `{ bytes, sha256, receipt, recordingError }`. The three optional ticket fields
  must be supplied together; production UI always supplies them. A ticket binds
  bytes to frozen authority, and the same write identity retries by verifying
  the existing file rather than overwriting an external change. Only a successful
  verified write can create a durable export receipt. A history transaction failure
  returns the saved file proof plus `recordingError`; it does not misreport the
  file as unsaved. Legacy unticketed harness writes return no history receipt.
  Ordinary document switches retain frozen tickets; full database replacement
  invalidates the generation, including in-flight renders and record publication.
  Tickets retain metadata only, expire after 15 minutes, and are capped at eight
  sessions and 256 write identities per session. Real OS failures map to
  domain codes: disk-full `STORAGE_FULL` (retryable), access denied
  `PERMISSION`, missing folder `NOT_FOUND`, other invalid conditions
  `VALIDATION`. The webview never writes files itself.

`document_state` includes `recentExports` (at most 20 receipts scoped to the
document) and `pendingImportCount` (only unfinished drafts bound to it). Export
history records the frozen cursor, source, artifact hash, actual write time,
filename, DPI and selected/source page counts. It does not persist full paths
or change the document revision. The UI checks actual PDF bytes for extractable
text/order, links and page count, and decodes PNG bytes for dimensions/page order
before asking for a save location. These checks make no universal ATS claim.

The default UI exports PDF and PNG through `render_document_export` plus these
delivery commands; the former browser-download flow (`export_document_pdf` blob
anchor) and the DOM-screenshot long image (html2canvas) are retired from the
production UI. `export_document_pdf` remains registered for fault-injection
test harnesses.

## Bounded fit proposal details

`fit_document_one_page({ cursor })` returns the Rust-generated `FitResult` with
the complete frozen cursor, resource-bound renderKey and read-only FitPlan. The
host freezes the authoritative draft and avatar lease; the persistent restricted
worker uses the same font, avatar, template and reference-date resources as preview.
Fit has a distinct format key and a 10-second host hard timeout; its engine budget
is 8 seconds checked before/after each compile. At most 16 candidates are compiled.
An initial unreadable layout returns `unreadable` without compiling; unsuccessful,
cancelled or timed-out plans have no fittedPresentation. Zero-page envelopes are
allowed only for fit plans with no attempts, never for PDF or preview outputs.

Planning does not write SQLite. Applying a successful proposal requires the existing
`apply_document_command` / `setLayout` path with the proposal's complete frozen
authority cursor; later edits reject that application through CAS. The default UI
uses this shared engine through `EngineFitClient`. Applying a fit is serialized with
draft persistence. Cancellation after dispatch cannot undo a durable CAS; the UI
reloads its authority cursor before a queued manual edit is saved, while preserving
the cancelled UI state. Real host cancellation and hard-timeout evidence remain
required; a deadline policy unit test alone does not prove host termination.

## Windows updater commands

Five additive main-window-only commands wrap the official
`tauri-plugin-updater` Rust API (`src-tauri/src/app_update.rs`). The plugin's
direct JS permissions (`updater:default`) are intentionally absent from every
capability; the webview can only reach the updater through these commands.

- `app_update_state()` returns the authoritative `UpdaterStatus` phase
  (`unconfigured | idle | checking | upToDate | available | downloading |
  readyToInstall | installing`). Phase changes also broadcast on the
  `updater-state-changed` event. Actions return failures as structured
  `AppError`; phases never encode errors.
- `app_update_check()` gates and flips to `checking` inside a single phase
  lock acquisition, so concurrent check/download/install calls cannot slip
  through the mutex between the read and the write. It refuses to run when
  the updater has no configured endpoint/public key.
  Trust chain: the embedded Tauri configuration supplies production defaults;
  compile-time `option_env!` values may override them;
  runtime environment overrides and HTTP endpoints are accepted only in
  debug or `test-hooks` builds, and the plugin itself rejects non-HTTPS
  endpoints in release. Manifest signature verification is mandatory with
  `requireSignedVersion: true` (see channel policy below): the downloaded
  artifact's signature must carry a trusted-comment version equal to the
  manifest version, so a tampered manifest cannot pair an inflated version
  with an older validly-signed artifact. Release notes are treated as
  untrusted input and rendered as plain text. Version comparison is stock
  semver (prereleases ordered, no downgrades, same version means no update).
- `app_update_download()` streams the official downloader with 120ms-throttled
  progress events. `total: null` means the server did not report a content
  length. Verified bytes are cached atomically under the data directory's
  `updater-cache/`; a restart restores an offline cache as `available`
  (cached flag), and a later download re-verifies and reuses the bytes without
  re-fetching. The official plugin exposes no download cancellation; this
  command runs the download on an abortable task, and
  `app_update_cancel_download()` truly aborts the HTTP stream and returns to
  `available`. No fake cancel semantics are implemented.
- `app_update_install()` requires `readyToInstall` and re-checks local
  integrity: cached bytes must match the recorded SHA-256 and pass signature
  verification against the trusted public key, current Update signature and
  signed version before reuse or installation. Mutable local metadata is not
  a trust anchor. A mismatch clears the cache and
  returns to `available`, where the download button is the re-download
  entry. Install first waits for in-flight exports to settle (export
  commands count through an export-flight guard) and rejects new exports
  once `installing` is published, so the process exit cannot truncate a
  file being written. Publishing `installing` is an atomic same-lock
  transition (double-clicks cannot spawn two installers); if the plugin
  fails to spawn the installer the phase retracts to `readyToInstall` and
  the error is returned. On success the plugin spawns the NSIS installer
  (passive UI plus restart-after-install) and exits the process, so the
  command does not return. Launching the installer is not success; success
  is the new version after relaunch. The frontend must settle saves (see
  below) before calling install; a failed save blocks installation on the
  UI side.
- Channel policy: production uses the configured GitHub `updates/latest.json`
  endpoint. Downgrades resolve to no update. `requireSignedVersion` is enabled
  in `tauri.conf.json`: artifacts require a version-bound trusted comment
  (`tauri signer sign --app-version <version>`); unsigned or wrong-version
  artifacts are rejected.
- Build hygiene: `test-hooks` allows runtime override of the update trust
  chain and is compile-time rejected in release-profile builds by
  `src-tauri/build.rs` unless `ZINECV_ALLOW_TEST_HOOKS_RELEASE=1` is set
  explicitly by the isolated local updater e2e or the fault-injection
  worker build; such builds are never released.

## Full database backup payload and restore behavior

`export_database_backup` and `restore_database_backup` are additive v1 command
names. They do not change existing command payloads. Full backup payloads use
the Rust-generated `DatabaseBackupPayload`: format `zinecv-sqlite-full-backup`,
version 1, Unix-seconds text, schema version, SHA-256 of the raw SQLite image,
and base64 database bytes. Raw images are limited to 128 MiB. The wrapper
contains the whole local database, including account records, conversation
history, provider profiles, encrypted DPAPI key blobs, resume drafts, template
revisions, and resources; the JSON wrapper itself is not encrypted.

The host verifies the raw-image hash, SQLite integrity, migration checksums,
foreign keys, resource sizes and hashes, active document/context/draft, and
supported schema before publishing a restore candidate. Supported older
schemas are migrated in the candidate. Restore preserves a verified
pre-restore database backup, publishes through SQLite Backup API on the single
live connection, clears the in-memory login session, and returns the resulting
schema and unreadable-secret count. DPAPI failures never delete or rewrite the
profile or ciphertext; the user can re-enter the key after logging in.

`replace_version_store` remains a graph-only operation. Older webviews may
still send its legacy `draft` field, but Rust ignores that value and carries
forward the current durable SQLite draft. The frontend flushes pending edits
before requesting the replacement.
