#!/usr/bin/env python3
# Needs: pip install fonttools brotli
# Example: python3 tools/make-logo.py public/fonts/ibm-plex-sans-latin-600-normal.woff2 public/media/uniguide-logo.svg [dark]
# Builds the UniGuide logotype as plain SVG shapes from IBM Plex Sans SemiBold (OFL), so the file looks
# the same on every computer, with no font needed. Usage: make_logo.py <font.woff2> <out.svg> [dark]
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

font_path, out, dark = sys.argv[1], sys.argv[2], len(sys.argv) > 3
font = TTFont(font_path)
cmap, gs = font.getBestCmap(), font.getGlyphSet()
NAVY, GOLD, LIGHT_GOLD = '#092b54', '#c58a12', '#f0c663'
uni_fill = '#ffffff' if dark else NAVY
guide_fill = LIGHT_GOLD if dark else GOLD
hole = NAVY if dark else '#ffffff'

size = 100                      # px per em
scale = size / font['head'].unitsPerEm
baseline = 120
tracking = -2 * 1000 / size     # a little tighter, like the site
x = 10.0
paths, pin_x, pin_top = [], None, None
for ch, fill in zip('Unı' + 'Guide', [uni_fill] * 3 + [guide_fill] * 5):
    name = cmap[ord(ch)]
    pen = SVGPathPen(gs)
    gs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
    paths.append(f'<path fill="{fill}" d="{pen.getCommands()}"/>')
    if ch == 'ı':
        bp = BoundsPen(gs); gs[name].draw(bp)
        xmin, ymin, xmax, ymax = bp.bounds
        pin_x = x + (xmin + xmax) / 2 * scale     # centre of the stem
        pin_top = baseline - ymax * scale         # top of the stem
    x += (gs[name].width + tracking) * scale
width = x + 14

# Map pin where the dot of the i would be.
r = 13
cx, cy = pin_x, pin_top - 30
pin = (f'<path fill="{guide_fill}" d="M{cx:.1f} {cy + 2.2 * r:.1f} C{cx - 1.2 * r:.1f} {cy + r:.1f} {cx - r:.1f} {cy + 0.6 * r:.1f} {cx - r:.1f} {cy:.1f}'
       f' a{r} {r} 0 0 1 {2 * r} 0 c0 {0.6 * r:.1f} {0.2 * r:.1f} {r:.1f} {-r:.1f} {2.2 * r:.1f}z"/>'
       f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r * 0.4:.1f}" fill="{hole}"/>')

# Route line with an arrowhead, under the whole name.
ly = baseline + 26
line = (f'<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="{LIGHT_GOLD}"/>'
        f'<stop offset="1" stop-color="{GOLD}"/></linearGradient></defs>'
        f'<rect x="12" y="{ly - 3}" width="{width - 36:.1f}" height="6" rx="3" fill="url(#g)"/>'
        f'<path d="M{width - 34:.1f} {ly - 13} L{width - 18:.1f} {ly} L{width - 34:.1f} {ly + 13}" fill="none" stroke="{GOLD}" '
        'stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>')

height = ly + 20
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {height}" role="img" aria-labelledby="t">'
       f'<title id="t">UniGuide</title>{"".join(paths)}{pin}{line}</svg>\n')
open(out, 'w').write(svg)
print(out, f'{width:.0f}x{height}')
