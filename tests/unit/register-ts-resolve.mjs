// 由 package.json 的 test:unit 经 --import 预加载，向全部测试线程注册 TS 解析钩子。
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);
