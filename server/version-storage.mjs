import {
  mkdir,
  readFile,
  writeFile,
  rename,
  copyFile,
  open,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validateVersionStore } from "./version-schema.mjs";

const endpoint = "/api/resume-versions";
const revisionOf = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// 数据目录独立于 dist，开发更新与重新构建不会删除用户版本。
export function versionStoragePlugin({ directory } = {}) {
  let dataDirectory;
  async function load() {
    try {
      const store = JSON.parse(
        await readFile(join(dataDirectory, "versions.json"), "utf8"),
      );
      const validation = validateVersionStore(store, { mode: "read" });
      if (!validation.valid)
        throw new Error(`版本文件结构无效：${validation.errors.join("；")}`);
      return { store, revision: revisionOf(store) };
    } catch (error) {
      if (error.code === "ENOENT") return { store: null, revision: "empty" };
      if (error instanceof SyntaxError)
        throw new Error("版本文件结构无效，原有文件未改动");
      throw error; // 损坏时拒绝写入，不能把现有历史当作空版本库。
    }
  }
  function configure(server) {
    server.middlewares.use(endpoint, async (request, response) => {
      const send = (status, value) => {
        response.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify(value));
      };
      let lock, temporary;
      try {
        if (request.method === "GET") return send(200, await load());
        if (request.method !== "POST")
          return send(405, { error: "不支持的操作" });
        if (
          request.headers.origin &&
          new URL(request.headers.origin).host !== request.headers.host
        )
          return send(403, { error: "请求来源不匹配" });
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 64 * 1024 * 1024)
            return send(413, { error: "版本库超过 64MB，请先导出备份" });
          chunks.push(chunk);
        }
        const { store, revision } = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        const validation = validateVersionStore(store, { mode: "write" });
        if (!validation.valid)
          return send(400, {
            error: `版本库结构无效：${validation.errors.join("；")}`,
          });
        await mkdir(dataDirectory, { recursive: true });
        try {
          lock = await open(join(dataDirectory, "versions.lock"), "wx");
        } catch (error) {
          if (error.code === "EEXIST")
            return send(409, { error: "版本库正在保存，请稍后重试" });
          throw error;
        }
        const current = await load();
        if (revision !== current.revision)
          return send(409, { error: "另一个窗口已更新版本库，请刷新后再操作" });
        if (current.revision === revisionOf(store))
          return send(200, { revision: current.revision });
        if (current.store)
          await copyFile(
            join(dataDirectory, "versions.json"),
            join(dataDirectory, "versions.backup.json"),
          );
        temporary = join(dataDirectory, `versions-${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
        await rename(temporary, join(dataDirectory, "versions.json"));
        temporary = null;
        send(200, { revision: revisionOf(store) });
      } catch (error) {
        send(500, {
          error:
            error instanceof Error
              ? error.message
              : "版本文件读取或保存失败，原有文件已保留",
        });
      } finally {
        if (temporary) await unlink(temporary).catch(() => {});
        if (lock) {
          await lock.close();
          await unlink(join(dataDirectory, "versions.lock")).catch(() => {});
        }
      }
    });
  }
  return {
    name: "resume-version-storage",
    configResolved(config) {
      dataDirectory = directory ?? join(config.root, ".data");
    },
    configureServer: configure,
    configurePreviewServer: configure,
  };
}
