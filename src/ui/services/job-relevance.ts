import type { ResumeState, ModuleKey, BasicInfo } from "../domain/resume-model";
import { basicFieldLabels } from "../agent/context";
import { moduleTitles } from "../domain/resume-model";
import { stripHtml } from "../utils/resume";

export type JobFact = { id: string; label: string; text: string };

export function jobFacts(resume: ResumeState): JobFact[] {
  const facts: JobFact[] = Object.entries(resume.basic).flatMap(([key, value]) =>
    key !== "avatar" && key !== "ageMode" && typeof value === "string" && value.trim()
      ? [{ id: `basic:${key}`, label: `基本信息 · ${basicFieldLabels[key as keyof BasicInfo]}`, text: value }] : []);
  if (stripHtml(resume.summary).trim()) facts.push({ id: "summary", label: "自我评价", text: stripHtml(resume.summary) });
  for (const module of Object.keys(moduleTitles) as ModuleKey[]) {
    for (const entry of resume[module] ?? []) {
      facts.push({ id: `entry:${module}:${entry.id}`, label: `${moduleTitles[module]} · ${entry.title || entry.role || "未命名经历"}`,
        text: [entry.title, entry.role, entry.department, entry.city, entry.start, entry.end, stripHtml(entry.html)].filter(Boolean).join(" · ") });
    }
  }
  return facts;
}

export function jobRequirements(description: string): string[] {
  return [...new Set(description.split(/[\r\n]+/).map(line => line.replace(/^\s*[-*•·\d、.）)]+\s*/, "").trim()).filter(Boolean))];
}

// Lexical overlap only suggests where to look. It never asserts that a skill
// or qualification is present, and never fabricates replacement resume text.
export function suggestJobEvidence(requirement: string, facts: JobFact[]): JobFact[] {
  const tokens = [...new Set(requirement.toLocaleLowerCase().match(/[a-z][a-z0-9+#.-]{1,}|[\u3400-\u9fff]{2,}/g) ?? [])];
  return facts.filter(fact => {
    const text = fact.text.toLocaleLowerCase();
    return tokens.some(token => text.includes(token) || token.length >= 4 && /^[\u3400-\u9fff]+$/.test(token)
      && [...token].some((_, index) => index < token.length - 1 && text.includes(token.slice(index, index + 2))));
  });
}
