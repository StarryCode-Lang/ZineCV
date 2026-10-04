# R01 synthetic acceptance inputs

These fixtures are generated only from deterministic fictional data. Do not replace the protected historical preview baseline or use a real browser profile, credential, resume, or `.data` file.

Run `node tools/generate-remaining-fixtures.mjs --write` to regenerate, then `node tools/generate-remaining-fixtures.mjs --check` to verify exact bytes and SHA-256. Page counts remain diagnostic until recorded with the current release renderer. The 1,000-commit graph is a UI/performance input, not proof of database throughput.

The fixed viewport/DPI/zoom matrix and benchmark sampling protocol live in `manifest.json`. Human IME, accessibility, installed-WebView2, visual comparison, and real model evidence remain separate.
