//! Shared font bytes. No rendering, storage, or platform dependencies.

// 内置字体的唯一来源。这三份字节同时被 engine（Typst 排版）、storage::resources
// （资源身份哈希）和 render_worker（宿主资源清单）使用；engine 再出口本模块的同一个
// `include_bytes!` 常量，避免同一份 ~22MB 字体数据在二进制里被复制多份。
//
// 这里刻意用 `static` 而不是 `const`：`const` 的具体值会在每个使用它的代码生成
// 单元里各展开一次，debug 构建（无 LTO、多 CGU）实测会把每份字体复制 3 份
// （测试二进制因此多出 ~44.6MB）；`static` 全程序只有一份，且让「零拷贝」可断言。
pub static FONT_REGULAR_BYTES: &[u8] =
    include_bytes!("../../../public/fonts/source-han-serif-cn-regular.otf");
pub static FONT_HEAVY_BYTES: &[u8] =
    include_bytes!("../../../public/fonts/source-han-serif-cn-heavy.ttf");
// 由本项目自带的 wondercv-iconfont.woff2 做纯格式转换得到（字形与字体
// 文件内容不变），Typst 的字体加载器只接受 ttf/otf。
pub static FONT_HEBREW_BYTES: &[u8] =
    include_bytes!("../../../public/fonts/noto-sans-hebrew-regular.ttf");

pub static FONT_ICON_BYTES: &[u8] = include_bytes!("../../../public/fonts/wondercv-iconfont.ttf");
