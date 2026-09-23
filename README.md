# ZineCV

ZineCV 是一个本地优先的 React 简历编辑器：左侧编辑内容，右侧实时生成固定 A4 预览，并支持模板导入、智能一页、版本分支和 PDF/PNG 导出。

[![Source license](https://img.shields.io/badge/source%20license-MIT-blue.svg)](LICENSE)

> 应用内仍保留 `Resume DIY` 工作区品牌。仓库中的项目源代码按 MIT 发布；随项目提供的字体、iconfont 和示例数据有单独的来源与授权边界，见 [第三方素材与发布边界](docs/third-party-assets.md)。

## 功能概览

- 基本信息、富文本经历、模块增删和拖拽排序。
- 固定 A4 预览，支持多页分页、预览内定位和 20%–200% 工作区缩放。
- 图片、PDF、DOCX 模板导入；识别结果映射到可编辑字段，不上传原始文件。
- 智能一页：只调整排版，不删减、改写或截断正文。
- 本地版本提交、分支创建/切换、历史恢复、分支树和备份保护。
- 浏览器内生成高清 PNG 与图像型 PDF；导出画面与 A4 预览保持一致。
- 支持系统“减少动态效果”，右侧 A4 正文、分页和导出不接入界面动效。

当前未接入云同步、账号、模板市场、AI 改写和文本型 PDF 导出。

## 快速开始

环境要求：Node.js 24 LTS、npm 12（版本以 `.nvmrc` 和 `package-lock.json` 为准）。

```bash
npm ci
npm run dev -- --host 127.0.0.1
```

打开 <http://127.0.0.1:5173/>。生产构建和本地预览：

```bash
npm run build
npm run preview -- --host 127.0.0.1
```

端口被占用时，项目会直接报错，不会静默切换端口。

## 存储、导出与固定预览边界

- 浏览器草稿、排版偏好、模块顺序和未提交版本保存在当前浏览器。通过 `npm run dev` 或 `npm run preview` 启动的项目文件接口会把已提交版本保存到 `.data/versions.json`，并保留 `.data/versions.backup.json`；普通静态托管没有这个文件接口，只能提供浏览器缓存。
- PDF 在浏览器内由 `html2canvas` 将可见的 A4 `.paper` 按 `2x` 画布渲染，再由 `jsPDF` 按 `A4 / 210×297mm` 写入。因此当前 PDF 是版式一致的图像型 PDF，不承诺可选中文本层；PNG 会按 `2x` 尺寸纵向拼接各页。
- 右侧 `.paper` 是固定的 A4 内容层。字体、图标字形、排版、分页和导出由 `src/styles/preview.css`、预览组件、分页服务和导出服务共同决定；外壳改动不能改变它们。
- 预览正文外的键盘/悬停轮廓属于独立交互层，不进入文档流、分页、打印或导出。`Tab` 可聚焦内容片段，`Enter` 或点击可定位到左侧编辑器，`Esc` 关闭浮层并恢复焦点；轮廓不会越过相邻模块。

`.data/` 是用户版本库，不是测试数据或构建产物。它被 Git 忽略，备份项目时需要在本地单独保留；不要把个人简历、浏览器存储或验收截图提交到仓库。

## 常用检查

| 目的                       | 命令                               |
| -------------------------- | ---------------------------------- |
| Lint、类型、格式和生产构建 | `npm run check`                    |
| 浏览器主回归               | `npm run test:browser`             |
| 预览定位与导出隔离         | `npm run test:preview-interaction` |
| 预览缩放、滚动和连续分栏   | `npm run test:preview-controls`    |
| 模板导入和智能一页         | `npm run test:template-workflow`   |
| 版本、分支和备份恢复       | `npm run test:versions`            |
| Motion 交互和减少动态效果  | `npm run test:motion`              |
| 快速拖拽的边界行为         | `npm run test:editor-drag`         |
| 模板收藏和最近使用         | `npm run test:template-library`    |
| 发布文档、素材和保护边界   | `npm run test:release-docs`        |

每次推送后，GitHub Actions 会在该提交上重建 GitNexus 索引、运行 ast-grep 结构扫描，并重新校验、交付 Archify 架构图。任务日志保留 GitNexus 与 ast-grep 结果；`code-intelligence-<提交号>` 工件保存扫描报告和对应提交的交互式架构图。GitHub 上的执行会更新 CI 工件，不会改写本地 `.gitnexus/` 或自动提交生成文件。

首次运行浏览器回归前安装 Chromium：

```bash
npx playwright install chromium
npm run test:browser
```

回归脚本使用独立浏览器上下文和临时数据目录，不操作正在使用的 `127.0.0.1:5173` 页面或用户 `.data`。验收产物位于被忽略的 `.artifacts/`，完成后可以删除。

## 架构与代码入口

高层关系见 [架构说明](docs/architecture.md)，可交互图由 [代码智能工作流](https://github.com/StarryCode-Lang/ZineCV/actions/workflows/code-intelligence-refresh.yml) 按提交交付，其源规格为 [architecture.archify.json](docs/architecture.archify.json)。核心数据流是：编辑器 → 简历状态 → A4 预览 → 分页/导出；版本管理将状态快照写入本地项目文件；回归测试在独立上下文中驱动编辑、预览、导出和版本恢复。

```text
src/
├─ app/             页面组合、编辑、分页、持久化和版本状态
├─ components/
│  ├─ editor/       基本信息、经历和富文本编辑
│  ├─ preview/      A4 内容、纸张容器和预览交互
│  ├─ templates/    图片/PDF/DOCX 导入和模板工作区
│  ├─ versioning/   历史列表、分支树和版本操作
│  └─ toolbar/      顶部操作和排版设置
├─ domain/          简历、模板、版本模型和默认内容
├─ services/        分页、复制、导出和版本文件服务封装
├─ styles/          工作区、预览、弹层、模板和响应式样式
└─ motion/          界面动效目录与减少动态效果适配
server/             本地版本文件接口
scripts/            构建、浏览器回归和契约验证
public/fonts/       当前 A4 预览依赖的字体与 iconfont
```

常见修改入口：默认内容在 `src/domain/initial-resume.ts`，编辑器在 `src/components/editor/`，A4 正文在 `src/components/preview/`，分页在 `src/services/resume-pagination.ts`，导出在 `src/services/resume-export.ts`，版本存储在 `server/version-storage.mjs` 和 `src/services/version-storage.ts`。

## 文档导航

- [架构与数据流](docs/architecture.md)：编辑器、预览、分页、导出、版本管理和回归测试的关系。
- [版本存储](docs/version-storage.md)：`.data`、浏览器缓存、原子写入、备份和冲突恢复。
- [工程维护状态](docs/maintenance-status.md)：当前实现、保护边界和验证入口。
- [第三方素材与发布边界](docs/third-party-assets.md)：字体、iconfont、示例数据和项目许可证范围。
- [Motion 审计证据](docs/design/motion-audit/README.md)：结构化审计报告与源码哈希说明。
- [贡献指南](.github/CONTRIBUTING.md)、[安全策略](.github/SECURITY.md)、[行为准则](.github/CODE_OF_CONDUCT.md)、[更新记录](docs/CHANGELOG.md)。

阶段性产品计划和动效迁移记录已合并到上述长期文档，不再维护带日期的旧版本说明。

## 仓库整理规则

根目录只保留工具自动发现的配置、应用入口、npm 清单与锁文件，以及 `README.md`、`LICENSE`、`NOTICE.md` 和项目级 `AGENTS.md`。协作文件集中在 `.github/`，更新记录在 `docs/`；生成式架构图由 CI 交付，不纳入源码。源码按职责留在 `src/`，回归脚本保留为可单独运行的检查入口。

`.data/`、`.audit/preview-baseline/`、`.gitnexus/`、`node_modules/` 和 `dist/` 保持本机可用；其中 `.data/` 是用户版本数据，固定基线是验收证据，GitNexus 是本地索引，`dist/` 与依赖目录用于本机预览。旧的 `.artifacts/` 截图、临时报告和 `tsconfig.tsbuildinfo` 属于可重建产物，验收结束后清理，不推送。完整逐项清单见 [工程维护状态](docs/maintenance-status.md)。

## 数据与隐私

首次打开使用空白简历；本机已有浏览器草稿和项目版本数据按各自存储路径恢复。不要把真实简历、头像、联系方式或 `.data` 内容用于公开截图。模板解析在浏览器中按需执行，原始图片/PDF/DOCX 不复制到项目，也不上传网络。发布截图请使用独立的虚构 fixture。

## 贡献与许可

欢迎通过 Issue 或 Pull Request 提交问题和改进。提交前请阅读 [贡献指南](.github/CONTRIBUTING.md)，并至少运行与改动范围匹配的检查。源代码和项目文档的许可证见 [LICENSE](LICENSE)；`public/fonts/` 等第三方素材不因该文件自动获得 MIT 授权，具体边界见 [NOTICE.md](NOTICE.md) 和素材文档。
