
#let payload = json("resume.json")
#let doc = payload.document
#let pres = doc.presentation
#let L = payload.layout
#let C = payload.contact
#let CM = payload.computed

#let mark(id) = metadata("node:" + id)
#let deco() = metadata("node:!deco")

#let markText(body, marks) = {
  let out = body
  for m in marks {
    if m == "bold" { out = strong(out) }
    else if m == "italic" { out = emph(out) }
    else if m == "underline" { out = underline(out) }
    else if m == "strike" { out = strike(out) }
  }
  out
}

// Typst source offsets are u16. Split only oversized leaves at grapheme
// boundaries and record each fragment's exact byte base, retaining one node ID.
#let markedText(id, value, marks) = {
  if bytes(value).len() <= 65535 { return mark(id) + markText(value, marks) }
  let out = none
  let chunk = ""
  let offset = 0
  for cluster in value.clusters() {
    if bytes(chunk).len() + bytes(cluster).len() > 32768 and chunk != "" {
      let piece = metadata("chunk:" + str(offset) + ":node:" + id) + markText(chunk, marks)
      out = if out == none { piece } else { out + piece }
      offset += bytes(chunk).len()
      chunk = ""
    }
    assert(bytes(cluster).len() <= 65535, message: "grapheme exceeds source-offset capacity")
    chunk += cluster
  }
  if chunk != "" {
    let piece = metadata("chunk:" + str(offset) + ":node:" + id) + markText(chunk, marks)
    out = if out == none { piece } else { out + piece }
  }
  out
}

// 把段落/链接子节点展平为带序号的文本叶子序列（break 占一个序号）。
#let flattenInlines(children, href) = {
  let leaves = ()
  for node in children {
    if node.type == "text" {
      leaves.push((text: node.text, marks: node.at("marks", default: ()), href: href))
    } else if node.type == "link" {
      leaves += flattenInlines(node.children, node.href)
    } else {
      leaves.push((brk: true, text: none, marks: (), href: none))
    }
  }
  leaves
}

#let renderInlineList(children, path) = {
  let leaves = flattenInlines(children, none)
  let out = none
  for (li, leaf) in leaves.enumerate() {
    let piece = if leaf.at("brk", default: false) {
      linebreak()
    } else {
      let body = markedText(path + ":l" + str(li), leaf.text, leaf.marks)
      if leaf.href != none { link(leaf.href, body) } else { body }
    }
    out = if out == none { piece } else { out + piece }
  }
  if out == none { [ ] } else { out }
}

// 列表块：有序/无序条目间距使用 --template-list-spacing。
// 有序编号是引擎合成文字，用 deco 括住（前后各一），不进入可选文本
// ——与旧 DOM 中 CSS marker 不可选中的行为一致。
#let renderListBlock(block, path) = {
  let items = ()
  for (ii, item) in block.items.enumerate() {
    let rendered = none
    for (bi2, inner) in item.enumerate() {
      let ipath = path + ":i" + str(ii) + ":b" + str(bi2)
      let piece = if inner.type == "paragraph" { renderInlineList(inner.children, ipath) } else { renderListBlock(inner, ipath) }
      rendered = if rendered == none { piece } else { rendered + parbreak() + piece }
    }
    let content = if rendered == none { [ ] } else { rendered }
    items += (content + deco(),)
  }
  deco()
  if block.ordered {
    let start = block.at("start", default: none)
    enum(start: if start == none { 1 } else { start }, indent: L.olIndentPt * 1pt, body-indent: L.olBodyIndentPt * 1pt, tight: false, spacing: L.listGapPt * 1pt, ..items)
  } else {
    let dot = circle(fill: rgb("#000000"), radius: (L.ulMarkerPt * 0.5) * 1pt)
    list(indent: L.ulIndentPt * 1pt, body-indent: L.ulBodyIndentPt * 1pt, tight: false, spacing: L.listGapPt * 1pt, marker: dot, ..items)
  }
}

// 富文本块序列：相邻块之间使用 --template-paragraph-spacing。
#let renderBlocks(blocks, path) = {
  let first = true
  for (bi, block) in blocks.enumerate() {
    if not first { v(L.paraGapPt * 1pt) }
    first = false
    if block.type == "paragraph" {
      set par(justify: pres.textAlign == "两端对齐")
      renderInlineList(block.children, path + ":b" + str(bi))
    } else if block.type == "list" {
      set par(justify: pres.textAlign == "两端对齐")
      renderListBlock(block, path + ":b" + str(bi))
    }
  }
}

// 单行元素盒：固定高度 + 垂直居中重现 CSS line-box 的半行距溢出对称。
#let lineBox(boxH, body) = {
  block(height: boxH * 1pt, breakable: false)[#align(center)[#body]]
}

#let contactIcon(glyph, topEm, bottomEm) = {
  text(font: "iconfont", size: L.contactIconPt * 1pt, top-edge: topEm * 1em, bottom-edge: bottomEm * 1em)[#glyph]
}

// 联系栏：图标与文字间 6px；span 间 13px（末项无尾距）。
// 图标字形为装饰文字（deco），联系值按字段身份标记。
// 图标与文字各自的 top/bottom-edge 由 layout 按各自字体的 strut 预计算，
// 行盒 = 两者调整后 ascent/descent 的最大值（与 Chromium 一致）。
#let contactLine(items) = {
  block(breakable: false)[
    #for (index, item) in items.enumerate() {
      if item.glyph != none { box[#deco()#contactIcon(item.glyph, L.contactIconTopEm, L.contactIconBottomEm) #h(L.contactIconGapPt * 1pt)] }
      mark(item.nodeId)
      text(fill: rgb(L.contactColor), size: L.fsPt * 1pt)[#item.value]
      if index < items.len() - 1 { h(L.contactSpanGapPt * 1pt) }
    }
  ]
}

#let siteCell(site) = {
  let shown = if site.url.starts-with("http") { site.url } else { "https://" + site.url }
  let domain = lower(shown)
  let logo = if domain.contains("github.com") {
    deco() + contactIcon("\u{e6fe}", L.siteIconTopEm, L.siteIconBottomEm)
  } else if domain.contains("csdn.net") {
    deco() + text(font: "Source Han Serif", size: L.csdnPt * 1pt, weight: 700, tracking: -0.4125pt)[CSDN]
  } else {
    deco() + contactIcon("\u{e75c}", L.siteIconTopEm, L.siteIconBottomEm)
  }
  // CSS 语义：logo 13px 定高盒 + 6px 间距 + 文本 nowrap/ellipsis；
  // Typst 无省略号，以列宽内 clip 近似（1fr 列自适应，不截短实际内容）。
  grid(columns: (auto, L.contactIconGapPt * 1pt, 1fr),
    box(height: L.iconCapPt * 1pt)[#logo],
    [],
    box(width: 100%, clip: true)[#mark(site.nodeId)#text(fill: rgb(L.contactColor), size: L.fsPt * 1pt)[#site.label]]
  )
}

// 节标题：图标（iconfont 或 lucide SVG）+ strong + 基线延展线 + 模板差异。
#let sectionIcon(kind, topEm, bottomEm) = {
  if kind == "awards" {
    image("/award.svg", width: 11.25pt, height: 11.25pt, fit: "contain")
  } else if kind == "education" {
    text(font: "iconfont", size: L.iconSizePt * 1pt, top-edge: topEm * 1em, bottom-edge: bottomEm * 1em)[#"\u{e76f}"]
  } else if kind == "skills" {
    text(font: "iconfont", size: L.iconSizePt * 1pt, top-edge: topEm * 1em, bottom-edge: bottomEm * 1em)[#"\u{e76b}"]
  } else if kind == "work" {
    text(font: "iconfont", size: L.iconSizePt * 1pt, top-edge: topEm * 1em, bottom-edge: bottomEm * 1em)[#"\u{e76d}"]
  } else if kind == "projects" {
    text(font: "iconfont", size: L.iconSizePt * 1pt, top-edge: topEm * 1em, bottom-edge: bottomEm * 1em)[#"\u{e774}"]
  } else if kind == "orgs" {
    text(font: "iconfont", size: L.iconSizePt * 1pt, top-edge: topEm * 1em, bottom-edge: bottomEm * 1em)[#"\u{e772}"]
  } else if kind == "summary" {
    text(font: "iconfont", size: L.iconSizePt * 1pt, top-edge: topEm * 1em, bottom-edge: bottomEm * 1em)[#"\u{e770}"]
  } else {
    image("/file-text.svg", width: 11.25pt, height: 11.25pt, fit: "contain")
  }
}

#let afterLine = rect(width: 100%, height: L.afterLinePt * 1pt, fill: rgb("#000000"))

// 节标题：图标（iconfont 或 lucide SVG）+ strong + 基线延展线 + 模板差异。
// strip 是 border-box 定高盒：内容盒 = strip − padding-bottom − 边框，
// strong（13px 行盒）与延展线在内容盒内由 layout 预计算定位。
#let sectionHead(section) = {
  let titleCell = box[#mark("section:" + section.id + ":head")#text(font: L.headingFont, tracking: L.headingTrackingPt * 1pt, fill: rgb(L.titleStrongColor), size: L.strongSizePt * 1pt, top-edge: L.strongTopEm * 1em, bottom-edge: L.strongBottomEm * 1em)[#strong(section.title)]]
  let lineCell = align(top)[#v((L.afterLineDyPt - L.titleCenterPt) * 1pt) #afterLine]
  block(below: L.titleMarginBottomPt * 1pt, breakable: false,
        stroke: if L.titleBorder != none { (bottom: L.titleBorder.sizePt * 1pt + rgb(L.titleBorder.color)) },
        inset: (bottom: L.titleBottomInsetPt * 1pt))[
    #lineBox(L.stripContentPt)[
      #v(L.titleCenterPt * 1pt)
      #if L.bar != none {
        grid(
          columns: (L.bar.widthPt * 1pt, L.bar.gapPt * 1pt, auto, L.iconGapPt * 1pt, 1fr),
          align(top)[#skew(ax: L.bar.skewDeg * 1deg)[#rect(width: L.bar.widthPt * 1pt, height: L.bar.heightPt * 1pt, radius: L.bar.radiusPt * 1pt, fill: rgb(L.accent))]],
          [],
          titleCell,
          [],
          lineCell,
        )
      } else if L.iconShown {
        grid(
          columns: (L.iconBoxPt * 1pt, L.iconGapPt * 1pt, auto, L.iconGapPt * 1pt, 1fr),
          box(height: L.iconCapPt * 1pt)[#deco()#sectionIcon(section.kind, L.stripIconTopEm, L.stripIconBottomEm)],
          [],
          titleCell,
          [],
          lineCell,
        )
      } else {
        grid(
          columns: (auto, L.iconGapPt * 1pt, 1fr),
          titleCell,
          [],
          lineCell,
        )
      }
    ]
  ]
}

// 条目头：单行（左 strong+inline 元数据 / 右日期）或双行（标题、日期、元数据三行）。
// 元数据/日期文案由 Rust 预计算（comp.meta / comp.inlineMeta / comp.range）。
// 行基线取两侧 strut 偏移的最大值（CSS flex 基线对齐的结果），标题格与
// 日期格各自带 layout 预计算的 top/bottom-edge；日期右侧保留 1px 内边距。
// headPadBottom 是 CSS padding-bottom：必须走 inset——Typst 相邻块的
// above/below 间距按 max 折叠，用 below 表达会被正文的 paraGap 吞掉。
#let entryHead(entry, comp) = {
  block(inset: (bottom: L.headPadBottomPt * 1pt), breakable: false)[
    #if pres.titleFormat == "单行标题" {
      grid(columns: (1fr, auto), column-gutter: L.headGapRightPt * 1pt,
        box[#mark("entry:" + entry.id + ":title")#text(fill: rgb(L.headStrongColor), size: L.fsPt * 1pt, top-edge: L.headTitleTopEm * 1em, bottom-edge: L.headTitleBottomEm * 1em)[#strong(text(font: L.headingFont, entry.title))#deco()#text(" ")#mark("entry:" + entry.id + ":imeta")#text(fill: rgb(L.inlineMetaColor), size: L.fsPt * 1pt)[#comp.inlineMeta]]],
        box(clip: true, inset: (right: L.datesPadRightPt * 1pt))[#mark("entry:" + entry.id + ":dates")#text(fill: rgb(L.dateColor), size: L.fsPt * 1pt, top-edge: L.headDatesTopEm * 1em, bottom-edge: L.headDatesBottomEm * 1em)[#comp.range]]
      )
    } else {
      grid(columns: (1fr, auto), column-gutter: 0.75pt,
        box[#mark("entry:" + entry.id + ":title")#text(fill: rgb(L.headStrongColor), size: L.fsPt * 1pt, top-edge: L.headTitleTopEm * 1em, bottom-edge: L.headTitleBottomEm * 1em)[#strong(text(font: L.headingFont, entry.title))]],
        box(clip: true, inset: (right: L.datesPadRightPt * 1pt))[#mark("entry:" + entry.id + ":dates")#text(fill: rgb(L.dateColor), size: L.fsPt * 1pt, top-edge: L.headDatesTopEm * 1em, bottom-edge: L.headDatesBottomEm * 1em)[#comp.range]]
      )
    }
    #if pres.titleFormat == "双行标题" and comp.meta != "" {
      block(above: L.metaMarginTopPt * 1pt, breakable: false)[#mark("entry:" + entry.id + ":meta")#text(fill: rgb(L.metaColor), size: L.fsPt * 1pt)[#comp.meta]]
    }
  ]
}

#let renderEntry(kind, entry, comp, first) = {
  block(above: if first { 0pt } else { L.entryGapPt * 1pt }, breakable: true)[
    #if kind == "education" {
      entryHead(entry, comp)
      block(above: L.paraGapPt * 1pt, breakable: true)[#renderBlocks(entry.body, "entry:" + entry.id)]
    } else {
      let hasHead = entry.start != "" or entry.end != "" or comp.meta != ""
      if hasHead {
        entryHead(entry, comp)
        block(above: L.paraGapPt * 1pt, breakable: true)[#renderBlocks(entry.body, "entry:" + entry.id)]
      } else if entry.title != "" {
        // 无头信息条目：标题进入正文首行（技能条目等）。
        mark("entry:" + entry.id + ":title")
        text(fill: rgb(L.headStrongColor), size: L.fsPt * 1pt)[#strong(entry.title)]
        v(L.paraGapPt * 1pt)
        renderBlocks(entry.body, "entry:" + entry.id)
      } else {
        block(above: L.paraGapPt * 1pt, breakable: true)[#renderBlocks(entry.body, "entry:" + entry.id)]
      }
    }
  ]
}

#let sectionBody(section, comp) = {
  if section.kind == "summary" {
    block(above: L.paraGapPt * 1pt, breakable: true)[#renderBlocks(section.body, "section:" + section.id)]
  } else {
    let first = true
    for (ei, entry) in section.entries.enumerate() {
      renderEntry(section.kind, entry, comp.entries.at(ei), first)
      first = false
    }
  }
}

// 页面与正文基础排版。行盒用 text(top/bottom-edge) 表达（见 layout_json 注释）。
#set page(width: 210mm, height: 297mm, margin: (top: pres.pageMarginPt * 1pt, right: pres.pageMarginPt * 1pt, bottom: pres.pageMarginPt * 1pt, left: pres.pageMarginPt * 1pt))
#set text(font: "Source Han Serif", size: L.fsPt * 1pt, fill: rgb(L.paperColor), lang: "zh", region: "cn", cjk-latin-spacing: none, top-edge: L.textTopEm * 1em, bottom-edge: L.textBottomEm * 1em)
#set par(leading: 0pt, spacing: 0pt, first-line-indent: 0pt)

// 头部：左主信息 + 右头像占位（头像缺席仍保留 64×88px 布局位）。
// h1 的 top/bottom-edge 由 layout 按（clear 的 Georgia）strut 预计算；
// clear 的 header-main 为 grid 布局，行距 3px、sites 顶距 1px 由 layout 下发。
#grid(
  columns: (1fr, 48pt),
  column-gutter: 12pt,
  block[
    #lineBox(L.h1LineHpt)[
      #mark("basic:name")#text(font: L.headingFont, fill: rgb("#000000"), size: L.h1SizePt * 1pt, tracking: L.h1TrackingPt * 1pt, top-edge: L.h1TopEm * 1em, bottom-edge: L.h1BottomEm * 1em)[#strong(doc.basic.name)]
    ]
    #v((L.h1MarginBottomPt + L.headerRowGapPt) * 1pt)
    #if C.primary.len() > 0 { contactLine(C.primary) }
    #if L.headerRowGapPt > 0 and C.secondary.len() > 0 { v(L.headerRowGapPt * 1pt) }
    #if C.secondary.len() > 0 { contactLine(C.secondary) }
    #if C.sites.len() > 0 {
      v((L.headerRowGapPt + L.sitesTopGapPt) * 1pt)
      grid(columns: (1fr, 1fr), column-gutter: 12pt, row-gutter: 12pt,
        ..C.sites.map(site => siteCell(site))
      )
    }
  ],
  box(width: 48pt, height: 66pt, radius: 2.25pt, clip: true, outset: 0pt)[
    #if L.hasAvatar {
      image("/avatar.png", width: 48pt, height: 66pt, fit: "cover")
    }
  ]
)
#block(
  above: 0pt,
  below: L.moduleGapPt * 1pt,
  outset: 0pt,
  inset: (bottom: L.headerBottomInsetPt * 1pt),
  stroke: if L.headerBorder != none { (bottom: L.headerBorder.sizePt * 1pt + rgb(L.headerBorder.color)) },
  breakable: false,
)[]

#let shown = 0
#for (si, section) in doc.sections.enumerate() {
  if section.visible {
    if shown > 0 { block(above: L.moduleGapPt * 1pt, breakable: false)[] }
    shown += 1
    block(breakable: true)[
      #sectionHead(section)
      #sectionBody(section, CM.sections.at(si))
    ]
  }
}
