# Motion 审计证据

这里保存与界面动效迁移和预览保护相关的结构化证据，不是产品路线图，也不是运行时配置。

## 保留内容

- `inventory.json`：CSS 动画、过渡和交互规则盘点。
- `motion-report.json`、`module-report.json`：迁移后的规则和模块摘要。
- `preview-interaction-report.json`：预览交互、打印和导出隔离结果。
- `baseline-comparison.json`：固定基线比较摘要。
- `protected-files.json`、`final-source-hashes.json`：保护文件和源码指纹。

迁移过程中的三张界面截图曾包含简历示例中的联系方式、经历和头像，已从公开仓库移除。后续若需要截图，必须使用虚构 fixture，并在提交前检查个人数据和第三方素材。

## 维护规则

修改界面动效或预览外壳时，先更新对应的源码证据和专项回归，再更新摘要 JSON。不要把截图差异直接当作正文差异，也不要为了让比较通过而覆盖固定基线。完整边界见 [`AGENTS.md`](../../../AGENTS.md) 和 [`maintenance-status.md`](../../maintenance-status.md)。
