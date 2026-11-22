# ZineCV

ZineCV 是一款本地优先的桌面简历编辑器：用结构化编辑完成内容，用接近印刷排版的 A4 预览确认结果，再导出 PDF 或 PNG。简历与版本历史保存在本机 SQLite，助手只连接用户自己配置的模型服务。

## 功能

- **结构化编辑**：基本信息、教育、经历、项目、技能等模块可增删、排序、折叠；富文本描述支持常用格式。
- **所见即所得**：A4 纸张预览、缩放与适应宽度、多页导航；点击预览可定位到对应模块。
- **模板与导入**：内置多套版式；支持 PDF、DOCX 导入，PDF 可保留原版式并逐框修改文字，也可进行离线 OCR。
- **版本与分支**：本地版本快照、分支图、对比与恢复，编辑过程可随时回溯。
- **导出**：PDF 与 PNG；导出前校验页面尺寸、文字顺序与资源完整性。
- **Agent 助手**：通过用户配置的模型服务生成或润色内容，密钥与请求由本机管理。
- **更新**：签名的应用更新，下载后校验再安装。

## 技术栈

- 桌面宿主：Tauri 2（Windows / WebView2）
- 界面：React 19 + TypeScript + Vite
- 核心：Rust workspace（contracts、domain、engine、storage、agent）
- 排版与存储：Typst、SQLite
- 导入：pdf.js、Mammoth、Tesseract.js

## 开发

需要 Node.js 24、Rust 稳定版与 MSVC Build Tools。

```powershell
npm ci
npm run dev        # 启动 Vite 与桌面宿主，前端热更新
```

常用检查：

```powershell
npm run check           # 日常轻量检查
npm run test:browser    # 浏览器行为回归
npm run check:native    # Rust 格式、Clippy 与单元测试
npm run build:native    # 生成 release 桌面程序
```

原生命令统一经 `tools/with-msvc.ps1` 加载 MSVC 环境；首次构建会下载并编译依赖，之后为增量构建。

## 文档

| 文档 | 内容 |
| --- | --- |
| [架构与不变量](docs/ARCHITECTURE_TARGET_CPLUS.md) | 模块边界、数据安全、平台能力注入 |
| [IPC 契约](docs/public-ipc-contract-v1.md) | React 与 Rust 的命令、类型和权限边界 |
| [资源许可](docs/resource-licenses.json)、[licenses](docs/licenses/) | 第三方组件与字体许可 |
| [NOTICE](NOTICE.txt) | 项目来源与许可说明 |

## 数据与隐私

简历、版本、设置与导入缓存默认保存在本机应用数据目录；不会上传到 ZineCV 服务。使用 Agent 时，所选内容会发送到用户配置的模型服务，是否启用由用户决定。更新包使用签名校验，密钥不随仓库分发。

## 许可

第一方源代码的授权方式见 [NOTICE.txt](NOTICE.txt)；第三方组件、字体与资源分别遵循其自带许可，明细见 `docs/licenses/` 与 `docs/resource-licenses.json`。
