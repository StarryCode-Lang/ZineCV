## 变更说明

<!-- 说明动机、范围和用户可见变化。避免把无关重构混入本 PR。 -->

## 验证

<!-- 列出实际运行的命令和结果。 -->

- [ ] `npm run check`
- [ ] 与改动范围匹配的专项回归
- [ ] 若涉及文档/发布边界：`npm run test:release-docs`

## 保护边界

- [ ] 未提交 `.data/`、个人简历、浏览器数据、密钥或构建产物
- [ ] 未覆盖 `.audit/preview-baseline/` 或为通过测试改写基线
- [ ] 若涉及预览、字体、分页或导出，已阅读 `AGENTS.md` 并验证 A4 契约
- [ ] 若涉及跨模块关系，已同步架构文档和 Archify 规格
- [ ] 若涉及第三方素材，已更新 `NOTICE.md` 或 `docs/third-party-assets.md`
