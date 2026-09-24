import { useState } from "react";
import { readStoredPreference } from "../utils/resume";
import { DEFAULT_PAGE_MARGIN_PX } from "../domain/resume-model";
import type { SeparatorMode } from "../domain/resume-model";

export function useLayoutSettings() {
  const [font, setFont] = useState(() => {
    const stored = readStoredPreference("font", "宋体");
    return stored === "微软雅黑" ? "雅黑" : stored;
  });
  const [fontSize, setFontSize] = useState(() =>
    readStoredPreference("fontSize", "13"),
  );
  const [lineHeight, setLineHeight] = useState(() =>
    readStoredPreference("lineHeight", "13"),
  );
  const [moduleSpacing, setModuleSpacing] = useState(() =>
    readStoredPreference("moduleSpacing", "0"),
  );
  const [pageMargin, setPageMargin] = useState(() => {
    const stored = Number(
      readStoredPreference("pageMargin", String(DEFAULT_PAGE_MARGIN_PX)),
    );
    // 旧版本把 5 表示成约 30px；迁移后控件直接显示真实页距。
    return String(stored < 20 ? Math.round(25.2362 + stored) : stored);
  });
  const [theme, setTheme] = useState(() =>
    readStoredPreference("theme", "#000000"),
  );
  const [smartFillEnabled, setSmartFillEnabled] = useState(
    () => readStoredPreference("smartFillV2", "false") === "true",
  );
  const [dateFormat, setDateFormat] = useState<"2021年1月" | "2021.01">(
    () =>
      readStoredPreference("dateFormat", "2021年1月") as
        "2021年1月" | "2021.01",
  );
  const [titleFormat, setTitleFormat] = useState<"双行标题" | "单行标题">(
    () =>
      readStoredPreference("titleFormat", "单行标题") as
        "双行标题" | "单行标题",
  );
  const [textAlign, setTextAlign] = useState<"系统默认" | "两端对齐">(() =>
    window.localStorage.getItem("resume-diy-layout-consistency-v1")
      ? (readStoredPreference("textAlign", "两端对齐") as
          "系统默认" | "两端对齐")
      : "两端对齐",
  );
  const [separator, setSeparator] = useState<SeparatorMode>(
    () => readStoredPreference("separator", "使用分隔符号") as SeparatorMode,
  );
  const [formatAutoFitRevision, setFormatAutoFitRevision] = useState(0);

  return {
    font,
    setFont,
    fontSize,
    setFontSize,
    lineHeight,
    setLineHeight,
    moduleSpacing,
    setModuleSpacing,
    pageMargin,
    setPageMargin,
    theme,
    setTheme,
    smartFillEnabled,
    setSmartFillEnabled,
    dateFormat,
    setDateFormat,
    titleFormat,
    setTitleFormat,
    textAlign,
    setTextAlign,
    separator,
    setSeparator,
    formatAutoFitRevision,
    setFormatAutoFitRevision,
  };
}
