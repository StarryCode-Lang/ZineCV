import { randomBytes, randomUUID, scrypt as scryptCallback, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod, copyFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const cookieName = "reme_agent_login";
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createLocalAgentAccounts(directory = resolve(".data")) {
  const path = join(directory, "agent-accounts.json");
  const backupPath = join(directory, "agent-accounts.backup.json");
  let cache;
  let mutation = Promise.resolve();
  const attempts = new Map();

  async function readStore() {
    if (cache) return cache;
    try {
      let content;
      try { content = await readFile(path, "utf8"); }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
        content = await readFile(backupPath, "utf8");
      }
      const value = JSON.parse(content);
      if (value.version !== 1 || !Array.isArray(value.accounts) || !Array.isArray(value.sessions))
        throw new Error("本地账户数据格式无效");
      cache = value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error("本地账户数据无法读取；请检查 .data/agent-accounts.json，不会自动覆盖它");
      cache = { version: 1, accounts: [], sessions: [] };
    }
    return cache;
  }

  async function save(store) {
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
    const rollback = `${path}.${randomUUID()}.previous`;
    let hadPrevious = false;
    try {
      await copyFile(path, backupPath);
      await rename(path, rollback);
      hadPrevious = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      if (hadPrevious) await rename(rollback, path);
      throw error;
    }
    if (hadPrevious) await unlink(rollback);
    try { await chmod(path, 0o600); } catch { /* Windows ACLs are managed by the user profile. */ }
  }

  function change(callback) {
    const next = mutation.then(async () => {
      await readStore();
      const draft = structuredClone(cache);
      const result = await callback(draft);
      await save(draft);
      cache = draft;
      return result;
    });
    mutation = next.catch(() => undefined);
    return next;
  }

  function normalizedEmail(value) {
    const email = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (email.length > 254 || !emailPattern.test(email)) throw new Error("请输入有效邮箱地址");
    return email;
  }

  function validPassword(value) {
    if (typeof value !== "string" || value.length < 10 || value.length > 256)
      throw new Error("密码长度需为 10–256 个字符");
    return value;
  }

  async function passwordHash(password, salt) {
    return (await scrypt(password, salt, 64)).toString("hex");
  }

  function newSession(store, accountId) {
    const token = randomBytes(32).toString("base64url");
    store.sessions = store.sessions.filter((item) => item.expiresAt > Date.now());
    store.sessions.push({ accountId, tokenHash: tokenHash(token), expiresAt: Date.now() + sessionLifetime });
    return token;
  }

  async function register(emailInput, passwordInput) {
    const email = normalizedEmail(emailInput);
    const password = validPassword(passwordInput);
    return change(async (store) => {
      if (store.accounts.some((item) => item.email === email)) throw new Error("此邮箱已注册，请直接登录");
      const salt = randomBytes(32).toString("hex");
      const account = { id: randomUUID(), email, salt, passwordHash: await passwordHash(password, salt), provider: null };
      store.accounts.push(account);
      return { account: { id: account.id, email }, token: newSession(store, account.id) };
    });
  }

  async function login(emailInput, passwordInput) {
    const email = normalizedEmail(emailInput);
    const password = validPassword(passwordInput);
    const attempt = attempts.get(email) ?? { count: 0, until: 0 };
    if (attempt.count >= 5 && attempt.until > Date.now()) throw new Error("尝试次数过多，请稍后重试");
    return change(async (store) => {
      const account = store.accounts.find((item) => item.email === email);
      const supplied = await passwordHash(password, account?.salt ?? "invalid-account-salt");
      const expected = account?.passwordHash ?? "0".repeat(128);
      const valid = timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
      if (!account || !valid) {
        attempts.set(email, { count: attempt.count + 1, until: Date.now() + 5 * 60_000 });
        throw new Error("邮箱或密码不正确");
      }
      attempts.delete(email);
      return { account: { id: account.id, email }, token: newSession(store, account.id) };
    });
  }

  async function session(request) {
    const cookie = String(request.headers.cookie ?? "").split(";").map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`));
    const token = cookie?.slice(cookieName.length + 1);
    if (!token || token.length > 128) return null;
    const store = await readStore();
    const item = store.sessions.find((entry) => entry.tokenHash === tokenHash(token) && entry.expiresAt > Date.now());
    if (!item) return null;
    const account = store.accounts.find((entry) => entry.id === item.accountId);
    return account ? { id: account.id, email: account.email, provider: account.provider } : null;
  }

  async function logout(request) {
    const cookie = String(request.headers.cookie ?? "").split(";").map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`));
    const token = cookie?.slice(cookieName.length + 1);
    if (token) await change((store) => { store.sessions = store.sessions.filter((item) => item.tokenHash !== tokenHash(token)); });
  }

  async function setProvider(accountId, provider) {
    await change((store) => {
      const account = store.accounts.find((item) => item.id === accountId);
      if (!account) throw new Error("登录状态已失效");
      account.provider = provider;
    });
  }

  return {
    register, login, logout, session, setProvider,
    cookie: (token) => `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}`,
    clearCookie: `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  };
}
