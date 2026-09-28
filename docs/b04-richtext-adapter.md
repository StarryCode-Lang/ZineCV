# B04 富文本适配进展

状态：`in_progress`。`src/bridge/legacyRichText.ts` 只在浏览器/WebView 中把旧版 HTML 解析为 Rust `RichBlock[]` 候选，并把结构化正文转回安全 HTML；它没有读取用户 localStorage、写 SQLite 或执行 B10 迁移。

解析使用 `DOMParser` 的节点树，不靠正则删标签。已映射段落、`div`、粗体/斜体/下划线/删除线、软换行、HTTP(S)/mailto 链接、无序/有序及嵌套列表；有序列表起始编号、中文全角、NBSP 和普通空白有共享金样。原始 HTML 总是随结果返回。未知标签/属性、非法链接、无效起始编号、注释、游离空白与资源限制产生带位置的 issue，`complete=false`；浏览器将危险节点移进 `<head>` 的情况也会报告。调用者不得将不完整候选自动提交，必须在迁移收据中保存原始输入并列出待处理差异。

`fixtures/legacy-richtext-golden.json` 由浏览器解析测试与 Rust 反序列化/领域校验测试共用；浏览器还验证“结构化正文→安全 HTML→再次解析”的语义 round-trip、`<p><br></p>`、非法链接和未知属性。`npm run test:browser` 3/3、`npm run test:native` 74/74、`npm run build` 通过。测试仅证明这些夹具；畸形 HTML 的所有修复行为、真实用户语料、与旧版 A4 精确布局、头像/资源和完整迁移尚未验收。预览冻结源码及用户 `.data` 未修改。

`src/bridge/legacySnapshot.ts` 进一步将旧 `ResumeVersionSnapshot` 只读转换成 `ResumeDocument` 候选：所有十种模块和 summary 均保留，旧显示顺序排在前面，其余模块作为隐藏模块保留；原 entry ID、模块标题和日期文本不改写。旧 CSS 像素的正文/行高/模块间距/页距与模板标题/段距/列表距逐项按 0.75 转 pt，旧原值写入 `legacyOverrides`。三种模板各用原 registry 默认值；原快照、原 HTML、头像字符串和模板引用保留在返回的 source/扩展信息中，未知字段列为 issue。

这个转换器仍只是 inspect/dry-run 前置能力：字体资源、头像和导入模板须由后续资产迁移核对后才能提交；重复 ID、未知字段/模板、非法排版和无法完整解析的富文本均留有路径诊断。它不读取旧 origin、没有写入 SQLite，也没有完成 source hash、实体映射、冲突处理、版本图、账户或迁移收据。`complete=false` 时不得提交；即使候选结构成立，也不等于视觉/A4 等价。独立浏览器夹具覆盖隐藏模块、ID、三种来源状态、像素单位、未知字段与部分解析；`npm run test:browser` 4/4、`npm run build` 通过。
