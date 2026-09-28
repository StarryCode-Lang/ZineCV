// 视觉对照共用的虚构夹具数据（与旧版 localStorage 键一致）。
const moduleKeys = ["education", "skills", "work", "projects", "orgs", "research", "awards", "other", "portfolio", "custom"];

export function visualFixture() {
  const resume = {
    basic: {
      name: "张三", phone: "138-0000-0000", email: "zhangsan@example.com",
      city: "上海", wechat: "zhangsan_dev", birth: "2001-06",
      ageMode: "birthday", website: "https://zhangsan.example.com",
      linkedin: "", gender: "", height: "", weight: "", ethnicity: "",
      birthplace: "", politicalStatus: "", maritalStatus: "", zodiac: "", mbti: "",
      avatar: "",
    },
    ...Object.fromEntries(moduleKeys.map((key) => [key, []])),
    summary: "<p>三年全栈开发经验，熟悉<b>React 与 Rust</b>，擅长把复杂系统拆成可维护的小模块。</p>",
    education: [{
      id: "edu-1", title: "某某大学", role: "计算机科学与技术", department: "", city: "",
      start: "2019-09", end: "2023-06", html: "<p>主修课程：数据结构、操作系统、编译原理</p><ol><li>GPA 3.8 / 4.0</li><li>校级一等奖学金</li></ol>",
    }],
    work: [
      { id: "work-1", title: "某科技公司", role: "前端工程师", department: "平台组", city: "上海", start: "2023-07", end: "2025-02", html: "<p>负责简历编辑器核心链路，<u>性能优化</u>与稳定性建设。</p><ul><li>首屏加载从 3s 降至 1s</li><li>崩溃率下降 40%</li></ul>" },
      { id: "work-2", title: "某创业公司", role: "实习工程师", department: "", city: "杭州", start: "2022-12", end: "2023-05", html: "<p>参与协作文档产品开发，负责<em>光标协同</em>与离线缓存。</p>" },
    ],
    projects: [{ id: "proj-1", title: "开源简历引擎", role: "", department: "", city: "", start: "2024-01", end: "2024-08", html: "<p>基于 Web 的所见即所得简历编辑器，支持<a href=\"https://example.com/repo\">开源仓库</a>。</p>" }],
  };
  const moduleOrder = ["education", "work", "projects", "summary", "skills"];
  const moduleNames = Object.fromEntries(moduleKeys.map((key) => [key, key === "work" ? "实习经历" : key]));
  const preferences = {
    font: "宋体", fontSize: "13", lineHeight: "13", moduleSpacing: "0",
    pageMargin: "30", theme: "#000000", smartFillV2: "false",
    dateFormat: "2021年1月", titleFormat: "单行标题", separator: "使用分隔符号", textAlign: "两端对齐",
  };
  return {
    "resume-diy-state": JSON.stringify(resume),
    "resume-diy-presentation-v1": JSON.stringify({ templateId: "legacy-v1", templateVersion: 1, densityPreset: "standard", overrides: {} }),
    "resume-diy-section-order-v2": JSON.stringify(moduleOrder),
    "resume-diy-modules": JSON.stringify(moduleOrder),
    "resume-diy-module-names": JSON.stringify(moduleNames),
    "resume-diy-title": "视觉对照简历",
    "resume-diy-summary-title": "自我评价",
    "resume-diy-preferences": JSON.stringify(preferences),
    "resume-diy-layout-consistency-v1": "true",
  };
}
