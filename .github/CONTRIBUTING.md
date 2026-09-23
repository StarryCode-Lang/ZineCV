# 贡献指南

感谢你为 ZineCV 提交问题、文档或代码。项目以本地优先的简历编辑体验为边界，优先接受可复现、范围清晰且不破坏现有 A4/数据契约的改动。

## 开始之前

- 使用 Node.js 24 LTS 和 npm 12；运行 `npm ci` 安装锁定依赖。
- 阅读 `AGENTS.md`、[README](../README.md) 和 [工程维护状态](../docs/maintenance-status.md)。
- 不要把 `.data/`、个人简历、浏览器数据、截图、密钥或构建产物加入提交。
- 涉及 `public/fonts/`、预览字体、分页、导出或固定基线时，先阅读 [第三方素材与发布边界](../docs/third-party-assets.md)。

## 开发流程

1. 从 `main` 创建一个短生命周期分支，例如 `fix/preview-focus` 或 `docs/project-guide`。
2. 保持改动聚焦，不顺手重构冻结的预览正文、分页和导出实现。
3. 修改跨模块关系时，先用 GitNexus 定位影响范围；TypeScript/TSX 结构搜索使用 npm 安装的 `ast-grep`；架构关系变化同步更新 `docs/architecture.archify.json`、`docs/architecture.md` 和交付图。
4. 提交前运行与改动相关的最小检查；准备合并时至少运行 `npm run check` 和 `npm run test:release-docs`。
5. 提交 Pull Request，说明行为变化、验证命令、已知限制以及是否涉及用户数据或第三方素材。

## 验证命令

```bash
npm run check
npm run test:release-docs
npm run test:versions       # 修改版本/持久化时
npm run test:preview        # 修改 A4/分页/导出时
npm run test:browser        # 修改交互或布局时
```

浏览器回归前先运行 `npx playwright install chromium`。测试必须使用独立上下文和临时数据目录，不能使用用户 `.data` 或正在运行的 5173 页面。

## 文档、素材和提交

- README 面向使用者；`docs/` 面向维护者和贡献者；阶段性计划完成后应合并为长期文档，不保留带日期的重复说明。
- 新增图片、字体、iconfont 或复制的外部文本时，必须在 `NOTICE.md` 或 `docs/third-party-assets.md` 写明来源和许可证；没有证据就标记为 `UNKNOWN`。
- 提交信息使用简洁的动词开头，例如 `docs: consolidate project guides`、`fix: preserve version backup`。
- 不要在公共 Issue 或 Pull Request 中粘贴访问 token、真实简历或其他个人数据；安全问题按 [SECURITY.md](SECURITY.md) 报告。

## Pull Request 检查清单

- [ ] 改动范围和动机已说明。
- [ ] 没有提交 `.data/`、`.artifacts/`、`.audit/`、构建产物或个人数据。
- [ ] 已运行与改动匹配的检查，并在描述中附上结果。
- [ ] 若涉及预览，已遵守 `AGENTS.md` 的冻结边界并验证 A4/导出。
- [ ] 若涉及架构或跨模块关系，已更新 Archify 规格并通过校验。
- [ ] 若涉及第三方素材，已更新来源和许可说明。
