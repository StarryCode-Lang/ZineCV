import { test } from "node:test";
import { strict as assert } from "node:assert";
import { structureRecognizedLines } from "../../src/ui/services/resume-content-recognition.ts";

// 页码 provenance 的单测：全部使用内存合成 RecognizedLine 输入，不触碰 fixtures/ 下任何夹具。
//
// 验证边界说明：import-draft.ts 的 evidence()/candidatesFrom() 是 evidence.page 的最终
// 消费方，但其静态导入链包含 template-import.ts 顶层的
// `import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"`（Vite 专有
// 查询后缀），node 无法解析，因此本文件直接断言 evidence.page 的唯一数据源——
// structureRecognizedLines 产出的 fieldProvenance（page + 来源行文本）。
// fieldProvenance → evidence() 的接线由 npm run check:ts 的类型约束覆盖。
// evidence() 的取值契约：page = source?.page ?? null，excerpt 优先取 source.text。

test("PDF：目标字段只出现在第 2/3 页时，字段 provenance 携带真实页码", () => {
  const content = structureRecognizedLines(
    [
      { text: "张三", page: 1 },
      { text: "求职意向：前端工程师", page: 1 },
      { text: "联系方式：zhangsan@example.com", page: 2 },
      { text: "电话：13800138000", page: 2 },
      { text: "教育经历", page: 2 },
      { text: "2016.09 - 2020.06 某大学 计算机科学与技术 本科", page: 2 },
      { text: "工作经历", page: 3 },
      { text: "2020.07 - 至今 某科技公司 前端工程师", page: 3 },
    ],
    "pdf",
  );
  // 基本信息字段：只出现在第 2 页 → 页码为 2，不是 1 也不是 null
  assert.equal(content.fieldProvenance["basic:email"]?.page, 2);
  assert.equal(content.fieldProvenance["basic:phone"]?.page, 2);
  // 来源行文本是结构化证据（该字段命中的第一行），而非显示文本匹配
  assert.equal(
    content.fieldProvenance["basic:email"]?.text,
    "联系方式：zhangsan@example.com",
  );
  assert.equal(content.fieldProvenance["basic:phone"]?.text, "电话：13800138000");
  // 姓名来源在第 1 页
  assert.equal(content.fieldProvenance["basic:name"]?.page, 1);
  assert.equal(content.fieldProvenance["basic:name"]?.text, "张三");
  // 模块字段：教育经历内容在第 2 页、工作经历内容在第 3 页
  assert.equal(content.fieldProvenance["section:education"]?.page, 2);
  assert.equal(content.fieldProvenance["section:work"]?.page, 3);
  // 自定义模块的首个来源（求职意向行）在第 1 页
  assert.equal(content.fieldProvenance["section:custom"]?.page, 1);
});

test("PDF：同一字段跨页出现时，provenance 记录首个可靠来源", () => {
  const content = structureRecognizedLines(
    [
      { text: "李四", page: 2 },
      { text: "电话：13900139000", page: 2 },
      { text: "工作经历", page: 3 },
      { text: "电话：13900139000", page: 3 },
    ],
    "pdf",
  );
  assert.equal(content.fieldProvenance["basic:phone"]?.page, 2);
  assert.equal(content.fieldProvenance["basic:phone"]?.text, "电话：13900139000");
});

test("PDF：值需要跨行拼接才能命中时，不编造单行页码（provenance 缺省）", () => {
  const content = structureRecognizedLines(
    [
      { text: "赵六", page: 1 },
      { text: "138", page: 1 },
      { text: "00138000", page: 1 },
    ],
    "pdf",
  );
  // 电话只在 join(" ") 后的全文中可匹配，任何单行都不包含完整值：
  // 此时不得把任一行的页码当作电话来源。
  assert.equal(content.fieldProvenance["basic:phone"], undefined);
});

test("DOCX/图片：没有页码时 provenance.page 保持 null，不编造 PDF 页码", () => {
  const lines = [
    { text: "王五" },
    { text: "wangwu@example.com" },
    { text: "电话：13700137000" },
    { text: "教育经历" },
    { text: "2017.09 - 2021.06 某大学 软件工程 本科" },
  ];
  for (const source of ["word", "image"]) {
    const content = structureRecognizedLines(lines, source);
    // 可定位字段的 provenance 条目存在，但 page 为 null
    const emailProvenance = content.fieldProvenance["basic:email"];
    assert.ok(emailProvenance, `${source} 应为可定位字段保留来源行`);
    assert.equal(emailProvenance.page, null);
    assert.equal(emailProvenance.text, "wangwu@example.com");
    // 全部 provenance 条目都不携带页码
    for (const [key, entry] of Object.entries(content.fieldProvenance))
      assert.equal(
        entry.page,
        null,
        `${source} 的 ${key} 不应携带页码`,
      );
  }
});
