// WebCrypto capability: non-exportable origin-local keys, ciphertext in SQLite.
let database, keyId, key;
const protectedValues = new Map(), revealedValues = new Map();
const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
async function get(id) { return request(database.transaction("keys").objectStore("keys").get(id)); }
async function put(id, value) {
  await new Promise((resolve, reject) => { const transaction = database.transaction("keys", "readwrite");
    transaction.objectStore("keys").put(value, id); transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(transaction.error); });
}
export async function init_secrets(scope) {
  if (!crypto.subtle || !indexedDB) throw new Error("浏览器安全密钥存储不可用");
  const opening = indexedDB.open(`zinecv-secrets:${scope}`, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("keys");
  database = await request(opening);
  keyId = await get("active");
  if (keyId) key = await get(keyId);
  else {
    keyId = crypto.randomUUID().replaceAll("-", "");
    key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await put(keyId, key); await put("active", keyId);
  }
  if (!key || key.extractable) throw new Error("浏览器安全密钥校验失败");
}
export async function prepare_secret(plaintext) {
  protectedValues.clear();
  const bytes = encoder.encode(plaintext), iv = crypto.getRandomValues(new Uint8Array(12));
  const header = encoder.encode(`ZCVW1:${keyId}:`);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header }, key, bytes));
  const result = new Uint8Array(header.length + iv.length + cipher.length);
  result.set(header); result.set(iv, header.length); result.set(cipher, header.length + iv.length);
  protectedValues.set(hex(bytes), result); revealedValues.set(hex(result), bytes);
}
export async function prepare_ciphertexts(ciphertexts) {
  for (const raw of ciphertexts) {
    const bytes = new Uint8Array(raw), id = new TextDecoder().decode(bytes.subarray(6, 38));
    if (revealedValues.has(hex(bytes))) continue;
    try {
      if (new TextDecoder().decode(bytes.subarray(0, 6)) !== "ZCVW1:" || bytes[38] !== 58) continue;
      const candidate = await get(id); if (!candidate || candidate.extractable) continue;
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(39, 51), additionalData: bytes.subarray(0, 39) }, candidate, bytes.subarray(51));
      revealedValues.set(hex(bytes), new Uint8Array(plain));
    } catch { /* Foreign, corrupt or unavailable ciphertext remains unavailable. */ }
  }
}
export function protect_sync(bytes) {
  const result = protectedValues.get(hex(bytes));
  if (!result) throw new Error("Secret was not prepared through WebCrypto");
  return result;
}
export function unprotect_sync(bytes) {
  const result = revealedValues.get(hex(bytes));
  if (!result) throw new Error("Secret unavailable in this browser");
  return result;
}
export function clear_plaintext() {
  protectedValues.clear();
  for (const bytes of revealedValues.values()) bytes.fill(0);
  revealedValues.clear();
}
export async function key_is_nonexportable() {
  try { await crypto.subtle.exportKey("raw", key); return false; } catch { return !key.extractable; }
}
