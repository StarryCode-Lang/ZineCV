# 旧版存储入口清单（B00，待动态核验）

本表只记录源码中的键名与来源，不读取或发布用户值。桌面 WebView2 不会自动继承旧浏览器 `127.0.0.1:5173` 的 localStorage，B10 必须提供原 origin 主动导出和文件导入。

| 来源 | 键或文件 | 内容类别 |
| --- | --- | --- |
| `src/app/App.tsx`、`src/utils/resume.ts` | `resume-diy-state`、`resume-diy-title`、`resume-diy-summary-title`、`resume-diy-module-names`、`resume-diy-modules`、`resume-diy-section-order-v2` | 正文、标题、模块名与顺序；含旧键回退 |
| `src/app/App.tsx`、`src/app/useLayoutSettings.ts`、`src/utils/resume.ts` | `resume-diy-presentation-v1`、`resume-diy-preferences`、`resume-diy-layout-consistency-v1`、`resume-diy-smart-fit-signature-v3` | 布局、格式、智能一页状态；逐字段按真实单位迁移 |
| `src/app/usePaneResize.ts` | `resume-diy-editor-pane-width` | 编辑/预览分栏宽度 |
| `src/domain/imported-template.ts`、`src/app/useImportedTemplates.ts` | `resume-diy-imported-templates-v1`、`resume-diy-active-imported-template`、`resume-diy-source-preview-dismissed:<templateId>` | 导入模板、活动模板与首屏原图覆盖状态 |
| `src/domain/template-library.ts` | `resume-diy-template-library-v1` | 收藏、最近使用等模板库元数据 |
| `src/domain/version-model.ts`、`src/services/version-storage.ts` | `resume-diy-version-store-v1`、`resume-diy-version-store-v1-backup`、`resume-diy-version-backup`、`resume-diy-version-project-revision` | 浏览器版本图、备份与项目文件关联状态 |
| `src/agent/sessions.ts` | `resume-diy-agent-sessions-v2:<accountId>` | 各本机账户的 Agent 会话 |
| `server/version-storage.mjs` | `.data/versions.json`、`.data/versions.backup.json` | 用户项目版本库；只读迁移，不修复、搬走或清空 |
| `server/local-agent-accounts.mjs` | `.data/agent-accounts.json` | 本机账户与模型配置；秘密状态需单独核验，不能写入公开 fixture |

此清单是静态源码入口盘点。B00 仍需用独立浏览器 profile、虚构数据和独立文件目录核对每个键的实际格式、序列化版本和所有退出/失败路径；不能据此宣称迁移已完成。
