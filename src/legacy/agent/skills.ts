import type { AgentView } from "./types";

export type AgentSkill = {
  id: string;
  title: string;
  description: string;
  views: AgentView[];
  requiresReferences: boolean;
  instruction: string;
};

export const agentSkills: AgentSkill[] = [
  {
    id: "new",
    title: "新建对话",
    description: "开始独立会话，保留旧对话记录",
    views: ["editor", "templates", "versions"],
    requiresReferences: false,
    instruction: "本地创建会话，不调用模型。",
  },
  {
    id: "sessions",
    title: "历史对话",
    description: "查看并切换已保存的会话",
    views: ["editor", "templates", "versions"],
    requiresReferences: false,
    instruction: "本地打开历史对话，不调用模型。",
  },
  {
    id: "help",
    title: "使用说明",
    description: "查看本项目支持的命令与引用",
    views: ["editor", "templates", "versions"],
    requiresReferences: false,
    instruction: "本地展示帮助，不调用模型。",
  },
  {
    id: "settings",
    title: "模型设置",
    description: "打开当前工作区的模型连接设置",
    views: ["editor", "templates", "versions"],
    requiresReferences: false,
    instruction: "本地打开设置，不调用模型或修改简历。",
  },
  {
    id: "polish",
    title: "优化表达",
    description: "保留事实，提出字段级改写",
    views: ["editor"],
    requiresReferences: true,
    instruction: "优化表达但保留原有事实与语气，不补造单位、职责或成果数字。",
  },
  {
    id: "shorten",
    title: "精简内容",
    description: "压缩选定经历，不触发自动排版",
    views: ["editor"],
    requiresReferences: true,
    instruction: "精简选定内容并保留关键事实；不能承诺或触发一页排版。",
  },
  {
    id: "collect-facts",
    title: "补充经历",
    description: "先询问职责、方法与结果",
    views: ["editor"],
    requiresReferences: true,
    instruction: "先提问补足用户事实；没有用户确认前不得生成经历或成果数字。",
  },
  {
    id: "check",
    title: "检查内容",
    description: "检查缺漏、重复与表达问题",
    views: ["editor"],
    requiresReferences: true,
    instruction: "仅检查所选范围，区分可核对的问题与风格建议，不预测招聘概率。",
  },
  {
    id: "explain-template",
    title: "解释模板",
    description: "说明已导入模板结构与切换影响",
    views: ["templates"],
    requiresReferences: true,
    instruction: "基于选定模板的真实识别结果说明版式、模块和应用副作用。",
  },
  {
    id: "check-import",
    title: "检查导入内容",
    description: "本地检查识别模块、空字段与警告",
    views: ["templates"],
    requiresReferences: true,
    instruction: "本地汇总已选模板的识别结果；原文件和图像不会发送到模型。",
  },
  {
    id: "apply-template",
    title: "申请应用模板",
    description: "先展示正文、模块与版式影响，再确认应用",
    views: ["templates"],
    requiresReferences: true,
    instruction: "只可为明确选中的真实模板提出完整影响提议，不得直接应用。",
  },
  {
    id: "compare-versions",
    title: "比较版本",
    description: "比较明确选择的两个本地快照",
    views: ["versions"],
    requiresReferences: true,
    instruction: "只比较明确引用的两个快照；不要自动恢复、切分支或保存。",
  },
  {
    id: "draft-commit",
    title: "生成版本说明",
    description: "根据当前草稿与 HEAD 的差异起草说明",
    views: ["versions"],
    requiresReferences: true,
    instruction: "根据用户明确授权的当前草稿与 HEAD 差异起草可编辑提交说明。",
  },
  {
    id: "save-version",
    title: "申请保存版本",
    description: "展示分支与说明，确认后调用现有保存流程",
    views: ["versions"],
    requiresReferences: false,
    instruction: "只能提出保存当前快照的确认请求，不可直接写入版本库。",
  },
];

export function availableAgentSkills(view: AgentView) {
  return agentSkills.filter((skill) => skill.views.includes(view));
}
