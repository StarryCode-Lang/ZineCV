const SECTION_KEYS = new Set([
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
  "summary",
]);

const SNAPSHOT_KEYS = [
  "resume",
  "moduleOrder",
  "moduleNames",
  "summaryTitle",
  "resumeTitle",
  "layout",
];

const LAYOUT_STRING_KEYS = [
  "font",
  "theme",
  "dateFormat",
  "titleFormat",
  "separator",
  "textAlign",
];

const LAYOUT_NUMBER_KEYS = [
  "fontSize",
  "lineHeight",
  "moduleSpacing",
  "pageMargin",
];

const DENSITY_PRESETS = new Set(["comfortable", "standard", "compact"]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const isFiniteLayoutValue = (value) => {
  if (typeof value === "number") return Number.isFinite(value);
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(Number(value))
  );
};

const pathText = (path) => path.join(".");

// 版本数据结构校验：只验证现有契约，不补默认值、不修改传入对象。
export function validateVersionStore(value, { mode = "read" } = {}) {
  const errors = [];
  const diagnostics = [];
  const error = (path, message) => errors.push(`${pathText(path)}：${message}`);
  const diagnostic = (path, message) =>
    diagnostics.push(`${pathText(path)}：${message}`);

  if (!isRecord(value)) {
    return {
      valid: false,
      errors: ["版本库：必须是对象"],
      diagnostics,
    };
  }

  if (!isNonEmptyString(value.currentBranchId))
    error(["currentBranchId"], "必须是非空字符串");
  if (!Array.isArray(value.branches)) error(["branches"], "必须是数组");
  if (!Array.isArray(value.commits)) error(["commits"], "必须是数组");
  if (errors.length) return { valid: false, errors, diagnostics };

  const branchIds = new Set();
  value.branches.forEach((branch, index) => {
    const path = ["branches", String(index)];
    if (!isRecord(branch)) {
      error(path, "必须是对象");
      return;
    }
    if (!isNonEmptyString(branch.id))
      error([...path, "id"], "必须是非空字符串");
    else if (branchIds.has(branch.id)) error([...path, "id"], "不能重复");
    else branchIds.add(branch.id);
    if (!isNonEmptyString(branch.name))
      error([...path, "name"], "必须是非空字符串");
    if (!isNonEmptyString(branch.createdAt))
      error([...path, "createdAt"], "必须是非空字符串");
    if (!hasOwn(branch, "headCommitId"))
      error([...path, "headCommitId"], "字段缺失");
    else if (
      branch.headCommitId !== null &&
      !isNonEmptyString(branch.headCommitId)
    )
      error([...path, "headCommitId"], "必须是字符串或 null");
  });
  if (!branchIds.has("main")) error(["branches"], "必须包含 main 分支");
  if (!branchIds.has(value.currentBranchId))
    error(["currentBranchId"], "必须引用现有分支");

  const commitIds = new Set();
  value.commits.forEach((commit, index) => {
    const path = ["commits", String(index)];
    if (!isRecord(commit)) {
      error(path, "必须是对象");
      return;
    }
    if (!isNonEmptyString(commit.id))
      error([...path, "id"], "必须是非空字符串");
    else if (commitIds.has(commit.id)) error([...path, "id"], "不能重复");
    else commitIds.add(commit.id);
    if (!isNonEmptyString(commit.branchId))
      error([...path, "branchId"], "必须是非空字符串");
    if (!hasOwn(commit, "parentId")) {
      diagnostic([...path, "parentId"], "旧历史缺少父提交字段，按断边兼容读取");
    } else if (commit.parentId !== null && !isNonEmptyString(commit.parentId)) {
      error([...path, "parentId"], "必须是字符串或 null");
    }
    if (typeof commit.message !== "string")
      error([...path, "message"], "必须是字符串");
    if (!isNonEmptyString(commit.createdAt))
      error([...path, "createdAt"], "必须是非空字符串");
    validateSnapshot(commit.snapshot, [...path, "snapshot"], error);
  });

  const commitById = new Map(
    value.commits
      .filter((commit) => isRecord(commit) && isNonEmptyString(commit.id))
      .map((commit) => [commit.id, commit]),
  );
  const reachableFromActiveHeads = new Set();
  const pending = value.branches
    .map((branch) => branch.headCommitId)
    .filter((id) => isNonEmptyString(id));
  while (pending.length) {
    const id = pending.pop();
    if (!id || reachableFromActiveHeads.has(id)) continue;
    const commit = commitById.get(id);
    if (!commit) continue;
    reachableFromActiveHeads.add(id);
    if (isNonEmptyString(commit.parentId)) pending.push(commit.parentId);
  }
  value.commits.forEach((commit, index) => {
    if (
      isRecord(commit) &&
      isNonEmptyString(commit.branchId) &&
      !branchIds.has(commit.branchId)
    ) {
      if (reachableFromActiveHeads.has(commit.id))
        diagnostic(
          ["commits", String(index), "branchId"],
          "来源分支已删除，按存活分支祖先历史保留",
        );
      else
        error(
          ["commits", String(index), "branchId"],
          "必须引用现有分支或存活分支祖先",
        );
    }
  });
  value.branches.forEach((branch, index) => {
    if (
      isRecord(branch) &&
      branch.headCommitId !== null &&
      isNonEmptyString(branch.headCommitId) &&
      !commitIds.has(branch.headCommitId)
    )
      error(
        ["branches", String(index), "headCommitId"],
        "必须引用现有提交或为 null",
      );
  });

  value.commits.forEach((commit, index) => {
    if (!isRecord(commit) || !isNonEmptyString(commit.id)) return;
    if (
      commit.parentId !== null &&
      isNonEmptyString(commit.parentId) &&
      !commitIds.has(commit.parentId)
    )
      diagnostic(
        ["commits", String(index), "parentId"],
        "父提交不存在，按旧断边历史保留",
      );
  });

  const visited = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    const commit = commitById.get(id);
    if (!commit) return false;
    visiting.add(id);
    const cycle =
      isNonEmptyString(commit.parentId) &&
      commitById.has(commit.parentId) &&
      visit(commit.parentId);
    visiting.delete(id);
    visited.add(id);
    return cycle;
  };
  value.commits.forEach((commit, index) => {
    if (isRecord(commit) && isNonEmptyString(commit.id) && visit(commit.id))
      error(["commits", String(index), "parentId"], "父提交关系不能形成循环");
  });

  // mode 作为明确的契约记录，读写都采用同一结构校验；旧断边仅是诊断。
  void mode;
  return { valid: errors.length === 0, errors, diagnostics };
}

export function validateVersionSnapshot(value) {
  const errors = [];
  validateSnapshot(value, ["snapshot"], (path, message) =>
    errors.push(`${pathText(path)}：${message}`),
  );
  return { valid: errors.length === 0, errors, diagnostics: [] };
}

function validateSnapshot(snapshot, path, error) {
  if (!isRecord(snapshot)) {
    error(path, "必须是对象");
    return;
  }
  SNAPSHOT_KEYS.forEach((key) => {
    if (!hasOwn(snapshot, key)) error([...path, key], "字段缺失");
  });
  const hasSchemaVersion = hasOwn(snapshot, "schemaVersion");
  const hasPresentation = hasOwn(snapshot, "presentation");
  if (hasSchemaVersion !== hasPresentation)
    error(path, "schemaVersion 与 presentation 必须同时存在或同时缺失");
  if (hasSchemaVersion && snapshot.schemaVersion !== 2)
    error([...path, "schemaVersion"], "当前仅支持版本 2");
  if (hasPresentation) {
    if (!isRecord(snapshot.presentation)) {
      error([...path, "presentation"], "必须是对象");
    } else {
      const presentation = snapshot.presentation;
      if (!isNonEmptyString(presentation.templateId))
        error([...path, "presentation", "templateId"], "必须是非空字符串");
      if (
        !Number.isInteger(presentation.templateVersion) ||
        presentation.templateVersion < 1
      )
        error([...path, "presentation", "templateVersion"], "必须是正整数");
      if (!DENSITY_PRESETS.has(presentation.densityPreset))
        error(
          [...path, "presentation", "densityPreset"],
          "必须是支持的密度预设",
        );
      if (!isRecord(presentation.overrides)) {
        error([...path, "presentation", "overrides"], "必须是对象");
      } else {
        Object.entries(presentation.overrides).forEach(([key, value]) => {
          if (
            typeof value !== "string" &&
            !(typeof value === "number" && Number.isFinite(value))
          )
            error(
              [...path, "presentation", "overrides", key],
              "必须是字符串或有限数字",
            );
        });
      }
    }
  }
  if (
    hasOwn(snapshot, "importedTemplate") &&
    snapshot.importedTemplate !== null
  ) {
    if (!isRecord(snapshot.importedTemplate)) {
      error([...path, "importedTemplate"], "必须是对象或 null");
    } else {
      if (!isNonEmptyString(snapshot.importedTemplate.id))
        error([...path, "importedTemplate", "id"], "必须是非空字符串");
      if (!isNonEmptyString(snapshot.importedTemplate.name))
        error([...path, "importedTemplate", "name"], "必须是非空字符串");
    }
  }
  if (!isRecord(snapshot.resume)) error([...path, "resume"], "必须是对象");
  if (!Array.isArray(snapshot.moduleOrder))
    error([...path, "moduleOrder"], "必须是数组");
  else {
    const seen = new Set();
    snapshot.moduleOrder.forEach((section, index) => {
      if (!isNonEmptyString(section) || !SECTION_KEYS.has(section))
        error(
          [...path, "moduleOrder", String(index)],
          "必须是当前支持的模块键",
        );
      else if (seen.has(section))
        error(
          [...path, "moduleOrder", String(index)],
          "模块顺序不能包含重复项",
        );
      else seen.add(section);
    });
  }
  if (!isRecord(snapshot.moduleNames))
    error([...path, "moduleNames"], "必须是对象");
  else
    Object.entries(snapshot.moduleNames).forEach(([key, name]) => {
      if (!isNonEmptyString(key) || typeof name !== "string")
        error([...path, "moduleNames", key], "模块名必须是字符串");
    });
  ["summaryTitle", "resumeTitle"].forEach((key) => {
    if (typeof snapshot[key] !== "string")
      error([...path, key], "必须是字符串");
  });
  if (!isRecord(snapshot.layout)) {
    error([...path, "layout"], "必须是对象");
    return;
  }
  [...LAYOUT_STRING_KEYS, ...LAYOUT_NUMBER_KEYS].forEach((key) => {
    if (!hasOwn(snapshot.layout, key))
      error([...path, "layout", key], "字段缺失");
  });
  LAYOUT_STRING_KEYS.forEach((key) => {
    if (typeof snapshot.layout[key] !== "string")
      error([...path, "layout", key], "必须是字符串");
  });
  LAYOUT_NUMBER_KEYS.forEach((key) => {
    if (!isFiniteLayoutValue(snapshot.layout[key]))
      error([...path, "layout", key], "必须是有限数字或数字字符串");
  });
}
