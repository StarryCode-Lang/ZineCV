// 导入版式的“文字层”模型：背景永远是源文件首页栅格，
// 只有被编辑过的文本框才画在背景之上，保证版式零漂移。
export type ImportedLayoutBox = {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  color: string;
  background: string;
  align: "left" | "center" | "right";
};

export type ImportedLayoutPage = {
  // 页面尺寸 = **原始栅格**尺寸（未经降采样），也是 boxes[].x/y/width/height
  // 所属的坐标系。
  width: number;
  height: number;
  // 背景位图：encodeBackground 会按上限降采样（长边 ≤1400），它的自然像素尺寸
  // 可能小于上面的 width/height（PDF 约差 2%，Word 约差 12%）。
  //
  // ⚠️ 坐标系陷阱：boxes 的坐标在原始栅格空间，background 的像素在降采样后的
  // 空间。直接拿 background 的像素去裁 boxes 的矩形，整块文字会偏 2%~12%。
  // 按背景取样/裁剪前必须先换算：scale = 背景自然尺寸 / {width, height}。
  // 渲染侧不受这条影响：ImportedLayoutPaper 把 <img> 拉伸回按原始栅格算出的
  // 页面矩形，降采样系数在渲染时精确抵消（实测落位差 ≤0.09 源栅格像素）。
  background: string;
  backgroundAssetId?: string;
};

export type ImportedSourceLayout = {
  version: 1;
  pages: ImportedLayoutPage[];
  boxes: ImportedLayoutBox[];
  extractedChars: number;
  warnings: string[];
};

export function effectiveBoxText(
  box: ImportedLayoutBox,
  edits: Record<string, string>,
) {
  const edited = edits[box.id];
  return typeof edited === "string" ? edited : box.text;
}

export function isBoxEdited(
  box: ImportedLayoutBox,
  edits: Record<string, string>,
) {
  const edited = edits[box.id];
  return typeof edited === "string" && edited !== box.text;
}
