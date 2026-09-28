# B10 旧版浏览器导出入口

状态：`in_progress`。旧版公开静态页 `public/legacy-export.html` 仅在原站点 `http://127.0.0.1:5173` 启用，用户点击后读取当前 origin 的 `localStorage` 中所有 `resume-diy-` 前缀记录，并生成本地 JSON 下载。不读取其他网站、不扫描浏览器 profile、不调用网络接口、不修改或清空原记录。页面不会在加载时读出记录值，下载文件中的原始值保留原字符串；站点内未知的同前缀键也一并保留，避免静默丢失。

格式 `zinecv-legacy-browser-export` v1 含 origin、导出时间、按键名排序的 `[key,value]` 数组及其 JSON UTF-8 字节 SHA-256。桌面侧只读 `src/bridge/legacyBrowserExport.ts` 已重新计算 hash、校验格式/origin/键命名/重复/顺序与大小，并把未识别的应用键列为人工复核项；无效文件不提供候选数据。它尚未逐键转换为完整迁移实体。该 hash 不是迁移幂等的完整 source namespace，也没有为用户选择来源身份。下载文件可能含简历与账户 Agent 会话，用户须本地保管。

独立浏览器上下文测试先写入两条项目记录和一条其他应用记录，验证只有项目键进入下载、字节 hash 正确、原缓存未改变、错误 origin 禁止导出。另以虚构文件验证桌面侧检查器拒绝篡改 hash、错误 origin、重复/外部/乱序键和坏 JSON，未知应用键须复核。`npm run test:browser` 6/6、桌面 `npm run build` 通过；旧版 `npm run build` 成功且输出 `dist/legacy-export.html`。未读取真实用户浏览器数据。

项目 `.data/versions.json`、备份、账户与 provider 配置不在浏览器包内。完整 B10 仍需手动文件入口、来源冲突与版本图、inspect/dryRun/commit/verify/receipt、资源与秘密迁移；不得将当前导出文件视为已迁移成功。
