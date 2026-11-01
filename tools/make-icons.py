# Q-CUBIC Remote - draws the app icons. Copyright (c) 2026 Pruthvi. All rights reserved.
import sys
from PIL import Image, ImageDraw, ImageFont

def icon(n, path):
    im = Image.new('RGB', (n, n), '#0B1220')
    d = ImageDraw.Draw(im)
    s = n / 512
    d.rounded_rectangle([96*s, 140*s, 416*s, 340*s], radius=22*s, outline='#EAF2FF', width=int(18*s))
    d.rectangle([226*s, 340*s, 286*s, 382*s], fill='#EAF2FF')
    d.rounded_rectangle([176*s, 372*s, 336*s, 394*s], radius=8*s, fill='#EAF2FF')
    try:
        f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(150*s))
    except Exception:
        f = ImageFont.load_default()
    d.text((256*s, 238*s), 'Q', font=f, fill='#22D3EE', anchor='mm')
    im.save(path)

out = sys.argv[1] if len(sys.argv) > 1 else '.'
for n in (192, 512, 1024):
    icon(n, f'{out}/icon-{n}.png')
