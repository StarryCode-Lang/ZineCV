import { convertFileSrc, isTauri } from "@tauri-apps/api/core";

// Install before the UI imports its styles or starts measuring text. Browser
// fixtures use the retained public files; native WebViews use engine bytes.
const fontUrl = (file: string) => isTauri()
  ? convertFileSrc(file, "zinecv-font")
  : `/fonts/${file}`;
const style = document.createElement("style");
const iconSource = isTauri()
  ? `url("${fontUrl("wondercv-iconfont.ttf")}") format("truetype")`
  : 'url("/fonts/wondercv-iconfont.woff2") format("woff2")';
style.dataset.zinecvFontSource = isTauri() ? "engine" : "public";
style.textContent = `
@font-face { font-family: "Noto Sans Hebrew"; font-style: normal; font-weight: 400; font-display: swap; unicode-range: U+0590-05FF, U+FB1D-FB4F; src: url("${fontUrl("noto-sans-hebrew-regular.ttf")}"); }
@font-face { font-family: "Source Han Serif CN"; font-style: normal; font-weight: 400; font-display: swap; src: url("${fontUrl("source-han-serif-cn-regular.otf")}"); }
@font-face { font-family: "Source Han Serif CN"; font-style: normal; font-weight: 900; font-display: swap; src: url("${fontUrl("source-han-serif-cn-heavy.ttf")}"); }
@font-face { font-family: "iconfont"; src: ${iconSource}; }
`;
document.head.append(style);
