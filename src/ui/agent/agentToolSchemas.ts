// Agent 工具的 JSON Schema 定义：只读宿主工具与四类待确认提议工具。
// 这些 schema 会随 agent_chat 传给模型，改变字段会直接影响模型的工具调用行为。

export const readToolNames = [
  "context_list_resources",
  "resume_read",
  "templates_list",
  "templates_read",
  "versions_list",
  "versions_read",
  "versions_diff",
  "ui_locate",
] as const;

export const readToolDefinitions = readToolNames.map((name) => ({
  type: "function",
  function: {
    name,
    description: `Read-only host tool ${name}. Only explicitly selected references may be read. Never assume a missing reference is authorized.`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        leftId: { type: "string" },
        rightId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
}));

export const resumeEditTool = {
  type: "function",
  function: {
    name: "propose_resume_patch",
    description:
      "提出一个仅针对当前用户明确引用的基本字段、自我评价或单条经历的修改提议。不会执行写入。",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["basic", "summary", "entry"] },
            key: { type: "string" },
            module: {
              type: "string",
              enum: [
                "education",
                "skills",
                "work",
                "projects",
                "orgs",
                "research",
                "awards",
                "other",
                "portfolio",
                "custom",
              ],
            },
            id: { type: "string" },
          },
          required: ["kind"],
          additionalProperties: false,
        },
        patch: { type: "object", additionalProperties: { type: "string" } },
        explanation: { type: "string" },
      },
      required: ["target", "patch", "explanation"],
      additionalProperties: false,
    },
  },
};

export const resumeDeleteTool = {
  type: "function",
  function: {
    name: "propose_resume_entry_delete",
    description:
      "只为用户明确引用的模块或经历提出删除某一条经历的待确认提议；必须使用给定的准确经历 ID，不会直接删除。",
    parameters: {
      type: "object",
      properties: {
        module: { type: "string" },
        id: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["module", "id", "explanation"],
      additionalProperties: false,
    },
  },
};

export const templateApplyTool = {
  type: "function",
  function: {
    name: "propose_template_application",
    description:
      "为用户明确引用的真实本地模板提出完整的应用提议，不会直接应用。",
    parameters: {
      type: "object",
      properties: {
        templateId: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["templateId", "explanation"],
      additionalProperties: false,
    },
  },
};

export const versionSaveTool = {
  type: "function",
  function: {
    name: "propose_version_save",
    description:
      "为当前草稿和用户已确认的分支提出保存版本的待确认提议，不会直接写入。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["message", "explanation"],
      additionalProperties: false,
    },
  },
};
