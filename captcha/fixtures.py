# SPDX-License-Identifier: AGPL-3.0-only
"""Generated fixtures, with no real accounts or downloaded CAPTCHA images."""
import base64
import io
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


def encoded(im):
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def scene(width, height, seed=7):
    random = np.random.default_rng(seed)
    small = random.integers(20, 235, (18, 20, 3), dtype=np.uint8)
    return cv2.resize(small, (width, height), interpolation=cv2.INTER_CUBIC)


def slider(x=173, y=51):
    original = scene(320, 170)
    mask = Image.new("L", (58, 58))
    draw = ImageDraw.Draw(mask)
    draw.rectangle((8, 8, 49, 49), fill=255)
    draw.ellipse((22, 0, 37, 16), fill=255)
    draw.ellipse((41, 21, 57, 37), fill=255)
    draw.ellipse((0, 21, 16, 37), fill=0)
    alpha = np.asarray(mask)
    crop = original[y:y+58, x:x+58].copy()
    piece = Image.fromarray(np.dstack([crop, alpha]))
    background = original.copy()
    patch = background[y:y+58, x:x+58]
    patch[alpha > 0] = (patch[alpha > 0] * 0.38).astype(np.uint8)
    outline = cv2.Canny(alpha, 40, 120)
    patch[outline > 0] = 240
    return {"kind": "slide", "background": encoded(Image.fromarray(background)),
            "piece": encoded(piece), "pieceX": 0, "pieceY": y, "pieceScale": 1,
            "expected": {"x": x, "y": y}, "width": 320, "height": 170,
            "pieceWidth": 58, "pieceHeight": 58}


def rotation(angle=47):
    original = scene(300, 300, 29)
    yy, xx = np.mgrid[:300, :300]
    r = np.hypot(xx-149.5, yy-149.5)
    alpha = ((r <= 148) & (r >= 80)).astype(np.uint8) * 255
    background = Image.fromarray(np.dstack([original, alpha]))
    inner = original[70:230, 70:230]
    yy, xx = np.mgrid[:160, :160]
    alpha = (np.hypot(xx-79.5, yy-79.5) < 79.5).astype(np.uint8) * 255
    piece = Image.fromarray(np.dstack([inner, alpha])).rotate(angle, resample=Image.Resampling.BICUBIC)
    return {"kind": "rotate", "background": encoded(background), "piece": encoded(piece),
            "pieceScale": 1, "expected": {"angle": angle % 360}, "width": 300, "height": 300,
            "pieceWidth": 160, "pieceHeight": 160}


def icon(kind, size=44):
    im = Image.new("RGBA", (size, size), "white")
    d = ImageDraw.Draw(im)
    if kind == "circle":
        d.ellipse((6, 6, size-6, size-6), fill="#255bd7")
    elif kind == "triangle":
        d.polygon([(size/2, 4), (size-3, size-5), (3, size-5)], fill="#255bd7")
    elif kind == "square":
        d.rectangle((7, 7, size-7, size-7), fill="#255bd7")
    elif kind == "star":
        points = []
        for i in range(10):
            angle = -math.pi/2 + i*math.pi/5
            radius = size*0.44 if i % 2 == 0 else size*0.18
            points.append((size/2+radius*math.cos(angle), size/2+radius*math.sin(angle)))
        d.polygon(points, fill="#255bd7")
    return im


def clicks():
    bg = Image.new("RGBA", (320, 170), "white")
    positions = [("circle", 38, 34), ("triangle", 158, 23), ("square", 81, 105), ("star", 235, 93)]
    for kind, x, y in positions:
        bg.alpha_composite(icon(kind), (x, y))
    order = ["star", "circle", "triangle"]
    points = [{"x": x+22, "y": y+22} for name in order for kind, x, y in positions if kind == name]
    return {"kind": "click", "background": encoded(bg), "targets": [encoded(icon(kind)) for kind in order],
            "instruction": "请按顺序点击以下图形", "expected": {"points": points}, "width": 320, "height": 170}


def words():
    font_path = next((p for p in [Path("C:/Windows/Fonts/msyh.ttc"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")] if p.exists()), None)
    if font_path is None:
        return None
    font = ImageFont.truetype(str(font_path), 45)
    chars = ["木", "中", "日"] if font_path.suffix == ".ttc" else ["3", "7", "2"]
    bg = Image.new("RGBA", (320, 170), "white")
    d = ImageDraw.Draw(bg)
    positions = [(38, 25), (155, 68), (246, 15)]
    for char, position in zip(chars, positions):
        d.text(position, char, font=font, fill="#151515")
    order = [chars[2], chars[0], chars[1]]
    return {"kind": "click", "background": encoded(bg), "instruction": '请依次点击“'+"、".join(order)+'”',
            "expected": {"order": order, "positions": positions}, "width": 320, "height": 170}


if __name__ == "__main__":
    print(json.dumps([slider(), rotation(), clicks()], ensure_ascii=True))
