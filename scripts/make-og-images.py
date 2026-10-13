#!/usr/bin/env python3
"""Render the Open Graph card for every post, plus one site-wide default.

Shares exactly, WhatsApp previews and Twitter cards all need a raster image —
an SVG renders as a grey box on most of them, and public/ only had SVGs. The
cards are generated rather than hand-made so a new post never ships without
one: this runs from `npm run build` (prebuild), writes into public/og/, and
Astro copies that into dist/ like any other static asset.

Palette and type are the site's own (aged paper, sepia ink, DejaVu Serif).
Rerunning is cheap and idempotent — a card is only rewritten when the source
post is newer than it.
"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
POSTS = ROOT / 'src' / 'content' / 'posts'
OUT = ROOT / 'public' / 'og'

# og:image is 1200x630 everywhere that matters (Facebook, Twitter/X,
# WhatsApp, Discord, LinkedIn all read this ratio).
W, H = 1200, 630
BG = (232, 223, 201)        # --color-bg
BG_SEC = (221, 210, 183)    # --color-bg-sec
INK = (43, 39, 35)          # --color-ink
ACCENT = (107, 74, 47)      # --color-accent
MUTED = (111, 101, 85)      # --color-muted
LINE = (203, 189, 158)      # --color-line

FONT_DIR = Path('/usr/share/fonts/truetype/dejavu')
SERIF_BOLD = FONT_DIR / 'DejaVuSerif-Bold.ttf'
SERIF = FONT_DIR / 'DejaVuSerif.ttf'
SANS = FONT_DIR / 'DejaVuSans.ttf'

CATEGORIES = {
    'tech': 'Tech',
    'finance': 'Finance',
    'current-affairs': 'Current Affairs',
    'books': 'Books',
}


def frontmatter(path):
    """Enough YAML for this schema — the fields are flat strings and dates."""
    text = path.read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---', text, re.S)
    if not m:
        return {}
    data = {}
    for line in m.group(1).split('\n'):
        kv = re.match(r'^(\w+):\s*(.*)$', line)
        if not kv:
            continue
        value = kv.group(2).strip()
        if len(value) > 1 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        data[kv.group(1)] = value
    return data


def wrap(draw, text, font, max_width):
    lines, line = [], ''
    for word in text.split():
        trial = f'{line} {word}'.strip()
        if draw.textlength(trial, font=font) <= max_width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def card(title, kicker, out_path):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)

    # Margin band + rules, so the card reads as the site and not as a stock
    # gradient. Nothing here depends on the title length.
    d.rectangle([0, 0, 48, H], fill=BG_SEC)
    d.line([(48, 0), (48, H)], fill=LINE, width=2)
    d.line([(110, 150), (W - 90, 150)], fill=LINE, width=2)

    f_kicker = ImageFont.truetype(str(SANS), 30)
    f_foot = ImageFont.truetype(str(SERIF), 28)

    d.text((110, 92), kicker.upper(), font=f_kicker, fill=ACCENT)

    # Shrink the title until it fits in four lines; long debugging titles are
    # the normal case here, not the exception.
    for size in (64, 58, 52, 46, 40):
        f_title = ImageFont.truetype(str(SERIF_BOLD), size)
        lines = wrap(d, title, f_title, W - 200)
        if len(lines) <= 4:
            break
    y = 210
    for line in lines[:4]:
        d.text((110, y), line, font=f_title, fill=INK)
        y += int(size * 1.35)

    d.line([(110, H - 110), (W - 90, H - 110)], fill=LINE, width=2)
    d.text((110, H - 85), 'cursedshrine.com/blog', font=f_foot, fill=MUTED)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, 'PNG', optimize=True)
    return out_path


def main():
    force = '--force' in sys.argv
    written = 0

    default = OUT / 'default.png'
    if force or not default.exists():
        card('Tech, homelab teardowns, finance and books.',
             'Cursed Shrine', default)
        written += 1

    for post in sorted(POSTS.glob('*/index.md*')):
        slug = post.parent.name
        out = OUT / f'{slug}.png'
        if not force and out.exists() and out.stat().st_mtime >= post.stat().st_mtime:
            continue
        fm = frontmatter(post)
        title = fm.get('title') or slug.replace('-', ' ')
        kicker = CATEGORIES.get(fm.get('category', ''), 'Cursed Shrine')
        card(title, kicker, out)
        written += 1

    total = len(list(OUT.glob('*.png')))
    print(f'og images: {written} written, {total} on disk')


if __name__ == '__main__':
    main()
