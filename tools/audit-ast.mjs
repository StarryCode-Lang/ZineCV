import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Read-only structural inventory. Findings are navigation evidence, not unused-code proof.
const installed = (process.env.PATH || '').split(path.delimiter)
  .map((directory) => path.join(directory, 'node_modules', '@ast-grep', 'cli', 'ast-grep.exe'))
  .find((candidate) => existsSync(candidate));
const executable = process.env.ZINECV_AST_GREP || installed || 'ast-grep';
const queries = [
  ['typed-native-ipc', 'TypeScript', 'nativeInvoke($$$ARGS)', 'src'],
  ['react-native-ipc', 'Tsx', 'nativeInvoke($$$ARGS)', 'src'],
  ['native-worker-spawn', 'Rust', 'Command::new($$$ARGS)', 'src-tauri/src'],
  ['native-secret-protection', 'Rust', 'CryptProtectData($$$ARGS)', 'crates/zinecv-native/src'],
  ['native-secret-unprotection', 'Rust', 'CryptUnprotectData($$$ARGS)', 'crates/zinecv-native/src'],
  ['agent-native-http', 'Rust', 'reqwest::Client::builder()', 'crates/zinecv-agent/src'],
  ['browser-worker-isolation', 'TypeScript', 'new Worker($$$ARGS)', 'src/platform/browser'],
  ['browser-single-writer-lock', 'JavaScript', 'navigator.locks.request($$$ARGS)', 'src/platform/browser'],
  ['portable-store-open', 'Rust', 'Store::from_platform_connection($$$ARGS)', 'crates'],
  ['browser-provider-fetch', 'JavaScript', 'fetch($$$ARGS)', 'crates/zinecv-agent/js'],
  ['browser-secret-encryption', 'JavaScript', 'crypto.subtle.encrypt($$$ARGS)', 'crates/zinecv-wasm/js'],
  ['ohos-napi-registration', 'C', 'napi_module_register($$$ARGS);', 'crates/zinecv-ohos/src'],
];
const version = spawnSync(executable, ['--version'], { encoding: 'utf8' });
if (version.status !== 0) throw new Error(version.stderr || 'Install ast-grep or set ZINECV_AST_GREP');
const results = queries.map(([id, language, pattern, root]) => {
  const result = spawnSync(executable, ['run', '--lang', language, '--pattern', pattern, '--json=compact', root], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (![0, 1].includes(result.status)) throw new Error(result.stderr || `${id} failed`);
  const matches = JSON.parse(result.stdout || '[]');
  console.log(`${id}: ${matches.length} matches`);
  return { id, language, pattern, matches };
});
mkdirSync('.artifacts/analysis', { recursive: true });
writeFileSync('.artifacts/analysis/ast-grep.json', JSON.stringify({ version: version.stdout.trim(), readOnly: true, results }, null, 2) + '\n');
