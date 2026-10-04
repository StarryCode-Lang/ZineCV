// node --test 的 ESM resolve 钩子：src/ 内部模块沿用 Vite 的无扩展名导入约定，
// 单测直接导入 src 模块时在此补全 .ts 扩展名。仅在默认解析失败时介入，
// 不影响显式写出扩展名的既有导入。
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) {
      throw error;
    }
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      throw error;
    }
  }
}
