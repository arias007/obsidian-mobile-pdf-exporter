# -*- coding: utf-8 -*-
"""
Merge script cmaps (Arabic / Hebrew / Thai / Devanagari) into the blank
invisible-text font used by mobile-pdf-exporter's selectable text layer.

Problem: NotoSansSC-Regular.blank.ttf has no cmap entries for Arabic etc.,
so fontkit maps every Arabic codepoint to glyph 0 (.notdef). pdf-lib then
builds a ToUnicode CMap that collapses ALL Arabic letters into one repeated
character ("ا"), which is exactly what users get when copying from the
exported PDF.

Fix: for every codepoint covered by the script source fonts (and missing in
the blank font), add a NEW blank glyph (no outlines, advance width taken from
the source font) and map it in the cmap. Distinct glyph per codepoint means
pdf-lib's ToUnicode maps each glyph back to its original codepoint, so copy/
search returns the logical text exactly.

The glyphs stay blank on purpose: the invisible layer must never paint.
"""
import os
import gzip
import io
import sys

from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen

BASE = r"C:\Users\35007\WorkBuddy\2026-09-20-12-57-46\mpe-src"
TARGET = os.path.join(BASE, "fonts", "NotoSansSC-Regular.blank.ttf")
OUT_TTF = os.path.join(BASE, "fonts", "NotoSansSC-Regular.blank.ttf")
SOURCES = [
    "NotoSansArabic-Regular.ttf.gz",
    "NotoSansHebrew-Regular.ttf.gz",
    "NotoSansThai-Regular.ttf.gz",
    "NotoSansDevanagari-Regular.ttf.gz",
]

target = TTFont(TARGET)
target_cmap = target.getBestCmap()
glyph_set = target.getGlyphSet()
glyph_order = target.getGlyphOrder()
glyf = target["glyf"]
hmtx = target["hmtx"]
upem = target["head"].unitsPerEm

added = {}
for name in SOURCES:
    path = os.path.join(BASE, "fonts", name)
    with open(path, "rb") as fh:
        data = gzip.decompress(fh.read())
    src = TTFont(io.BytesIO(data), lazy=True)
    src_cmap = src.getBestCmap()
    src_upem = src["head"].unitsPerEm
    src_hmtx = src["hmtx"]
    count = 0
    for cp, gname in src_cmap.items():
        if cp in target_cmap:
            continue
        if cp < 0x20 or cp == 0x7f or cp >= 0x10000:
            # format 4 subtable (BMP) is what Windows/OT tooling relies on
            # for these fonts; keep additions BMP-only for safety.
            continue
        adv, _lsb = src_hmtx[gname]
        scaled = round(adv * upem / src_upem)
        new_name = "uni%04X.blank" % cp
        if new_name in glyph_order:
            continue
        pen = TTGlyphPen(glyph_set)
        empty = pen.glyph()
        # glyf.__setitem__ auto-appends new names to glyf.glyphOrder (same
        # list object as font-level glyph order) — do NOT append manually.
        glyf[new_name] = empty
        hmtx[new_name] = (scaled, 0)
        target_cmap[cp] = new_name
        count += 1
    added[name] = count
    src.close()

# write merged cmap back into every unicode subtable, then sync glyph order
# (fontTools requires glyf.glyphs keys == glyph order list length)
cmap_table = target["cmap"]
for subtable in cmap_table.tables:
    if subtable.isUnicode():
        subtable.cmap = dict(target_cmap)

target.setGlyphOrder(glyph_order)
target["glyf"].glyphOrder = list(glyph_order)

# safety net: every glyph in the order MUST have hmtx AND vmtx metrics
# (vmtx/vhea exist in this font; its compile path shares the hmtx code)
for metrics_table in ("hmtx", "vmtx"):
    if metrics_table not in target:
        continue
    tbl = target[metrics_table]
    missing = [n for n in glyph_order if n not in tbl.metrics]
    if missing:
        print("missing %s metrics (will fix):" % metrics_table, missing[:10], "count", len(missing))
        for n in missing:
            tbl.metrics[n] = (upem // 2, 0)

print('order', len(glyph_order), 'glyf.glyphs', len(target['glyf'].glyphs), 'glyf.glyphOrder', len(target['glyf'].glyphOrder))
target.save(OUT_TTF)
print("added per source:", added)
print("total cmap now:", len(target_cmap))

# verify reload
check = TTFont(OUT_TTF, lazy=True)
cm = check.getBestCmap()
for cp in (0x0627, 0x0644, 0x0639, 0x0631, 0x0628, 0x064A, 0x0629, 0x05D0, 0x0E01, 0x0915):
    print(hex(cp), cm.get(cp))
