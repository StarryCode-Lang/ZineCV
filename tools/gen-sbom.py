import json, io, hashlib, os
rust_deps = []
entry = None
for line in io.open('src-tauri/Cargo.lock', encoding='utf-8'):
    line = line.rstrip('\n')
    if line.startswith('[[package]]'):
        if entry is not None and entry.get('source'):
            rust_deps.append(entry)
        entry = {}
        continue
    if entry is not None and line.startswith('name = '):
        entry['name'] = line.split('"')[1]
    elif entry is not None and line.startswith('version = '):
        entry['version'] = line.split('"')[1]
    elif entry is not None and line.startswith('source = '):
        entry['source'] = line.split('"')[1]
if entry is not None and entry.get('source'):
    rust_deps.append(entry)
npm = json.load(io.open('package-lock.json', encoding='utf-8'))
npm_pkgs = []
for path, info in npm.get('packages', {}).items():
    if not path or info.get('dev'):
        continue
    npm_pkgs.append({
        'path': path.replace('node_modules/', '', 1),
        'version': info.get('version'),
    })
manifest = []
for root, dirs, files in os.walk('dist'):
    for f in files:
        p = os.path.join(root, f).replace(os.sep, '/')
        h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
        manifest.append({'path': p, 'bytes': os.path.getsize(p), 'sha256': h})
out = {
    'generatedAt': '2026-10-02',
    'product': {'name': 'ZineCV', 'version': '2.0.0-alpha.0', 'identifier': 'com.zinecv.desktop'},
    'rustDependencies': sorted(rust_deps, key=lambda d: d['name']),
    'npmDependencies': sorted(npm_pkgs, key=lambda d: d['path']),
    'bundledResources': manifest,
    'notice': 'Third-party license texts ship inside the bundle under licenses/ (dist/licenses).',
}
with io.open('.artifacts/remaining/R30/session4/sbom.json', 'w', encoding='utf-8') as fh:
    json.dump(out, fh, ensure_ascii=False, indent=1)
print('rust deps:', len(rust_deps), '| npm deps:', len(npm_pkgs), '| dist files:', len(manifest))
