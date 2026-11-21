#!/usr/bin/env python3
"""Make a 1200x630 share image (the X / social card) from a post's lead picture.

    python3 scripts/make_share_image.py public/posts/<slug>/lead.jpg public/posts/<slug>/share.jpg

The whole picture is kept: it's scaled to fit and centred on a blurred, darkened copy
of itself, so a portrait photo isn't cropped to a strip. Needs Pillow (pip install pillow).
Then put `share: /posts/<slug>/share.jpg` in the post's front matter.
"""
import sys
from PIL import Image, ImageFilter, ImageEnhance

W, H = 1200, 630

def main(src, dst):
    im = Image.open(src).convert("RGB")
    # Background: cover the frame, blur, darken.
    s = max(W / im.width, H / im.height)
    bg = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    l, t = (bg.width - W) // 2, (bg.height - H) // 2
    bg = bg.crop((l, t, l + W, t + H)).filter(ImageFilter.GaussianBlur(28))
    bg = ImageEnhance.Brightness(bg).enhance(0.55)
    # Foreground: the full picture, fit inside the frame.
    f = min(W / im.width, H / im.height)
    fg = im.resize((round(im.width * f), round(im.height * f)), Image.LANCZOS)
    bg.paste(fg, ((W - fg.width) // 2, (H - fg.height) // 2))
    bg.save(dst, quality=88, optimize=True, progressive=True)
    print(f"wrote {dst} ({W}x{H})")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
