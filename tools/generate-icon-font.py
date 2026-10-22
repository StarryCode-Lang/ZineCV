"""Rebuild the 13 legacy-codepoint icons from Font Awesome 4.7.0 (OFL-1.1).

Usage: python tools/generate-icon-font.py <upstream fontawesome-webfont.ttf>
Requires fontTools with Brotli support; not part of ordinary app builds.
"""
import json
import sys
from hashlib import sha256
from pathlib import Path
from fontTools import subset
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem

ROOT = Path(__file__).resolve().parents[1]
MAPPING = {
    0xE774: 0xF0B1, 0xE76B: 0xF040, 0xE76D: 0xF0F6,
    0xE76F: 0xF19D, 0xE770: 0xF007, 0xE772: 0xF0C0,
    0xE732: 0xF041, 0xE73E: 0xF1D7, 0xE74A: 0xF0E0,
    0xE75B: 0xF095, 0xE75C: 0xF0AC, 0xE75E: 0xF1FD,
    0xE6FE: 0xF09B,
}

source = Path(sys.argv[1])
font = TTFont(source, recalcTimestamp=False)
scale_upem(font, 1024)
cmap = font.getBestCmap()
names = {target: cmap[original] for target, original in MAPPING.items()}
options = subset.Options()
options.name_IDs = ['*']
options.name_legacy = True
options.name_languages = ['*']
subsetter = subset.Subsetter(options=options)
subsetter.populate(glyphs=list(names.values()))
subsetter.subset(font)
for table in font['cmap'].tables:
    if table.isUnicode():
        table.cmap = dict(names)
glyph_set = font.getGlyphSet()
for glyph_name in set(names.values()):
    glyph = font['glyf'][glyph_name]
    glyph.recalcBounds(font['glyf'])
    width = glyph.xMax - glyph.xMin
    scale = min(1, 896 / max(1, width))
    offset = (1024 - width * scale) / 2 - glyph.xMin * scale
    pen = TTGlyphPen(glyph_set)
    glyph_set[glyph_name].draw(TransformPen(pen, (scale, 0, 0, scale, offset, 0)))
    font['glyf'][glyph_name] = pen.glyph()
    font['glyf'][glyph_name].recalcBounds(font['glyf'])
    font['hmtx'][glyph_name] = (1024, font['glyf'][glyph_name].xMin)
font['hhea'].ascent, font['hhea'].descent, font['hhea'].lineGap = 896, -128, 92
font['OS/2'].sTypoAscender, font['OS/2'].sTypoDescender, font['OS/2'].sTypoLineGap = 896, -128, 0
font['OS/2'].usWinAscent, font['OS/2'].usWinDescent = 988, 131
font['OS/2'].version = 4
font['OS/2'].fsSelection = 192
font['OS/2'].fsType = 0
for name_id, text in {1: 'iconfont', 2: 'Regular', 3: 'ZineCVSymbols-FA47',
                      4: 'ZineCV Symbols', 6: 'ZineCVSymbols', 16: 'iconfont',
                      17: 'Regular', 13: 'SIL Open Font License 1.1',
                      14: 'https://openfontlicense.org/'}.items():
    for platform, encoding, language in [(3, 1, 0x409), (1, 0, 0)]:
        font['name'].setName(text, name_id, platform, encoding, language)
directory = ROOT / 'public/fonts'
font.flavor = None
font.save(directory / 'wondercv-iconfont.ttf')
font.flavor = 'woff2'
font.save(directory / 'wondercv-iconfont.woff2')
manifest = {'source': 'https://raw.githubusercontent.com/FortAwesome/Font-Awesome/v4.7.0/fonts/fontawesome-webfont.ttf',
            'sourceSha256': sha256(source.read_bytes()).hexdigest(), 'license': 'OFL-1.1',
            'family': 'iconfont', 'modifiedName': 'ZineCV Symbols',
            'legacyFilenamesRetainedForCompatibility': True,
            'mapping': {f'{a:04x}': f'{b:04x}' for a, b in MAPPING.items()}}
(directory / 'icon-source.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
