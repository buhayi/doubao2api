# SPDX-License-Identifier: AGPL-3.0-only
"""Local CAPTCHA image matching. JSON-lines in/out; no HTTP client or listener."""
import base64
import io
import json
import math
import re
import sys
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image

MAX_IMAGE = 2 * 1024 * 1024
MAX_REQUEST = 10 * 1024 * 1024


class Uncertain(ValueError):
    pass


def image(value):
    if not isinstance(value, str) or len(value) > MAX_IMAGE * 4 // 3 + 8:
        raise Uncertain("invalid_image")
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) > MAX_IMAGE:
            raise Uncertain("image_too_large")
        with Image.open(io.BytesIO(raw)) as im:
            if not (12 <= im.width <= 1200 and 12 <= im.height <= 1200):
                raise Uncertain("invalid_dimensions")
            if im.width * im.height > 1_000_000:
                raise Uncertain("image_too_large")
            return np.asarray(im.convert("RGBA")).copy()
    except Uncertain:
        raise
    except Exception:
        raise Uncertain("invalid_image") from None


def png(im):
    buf = io.BytesIO()
    Image.fromarray(im.astype(np.uint8)).save(buf, format="PNG")
    return buf.getvalue()


def gray(im):
    return cv2.cvtColor(im[:, :, :3], cv2.COLOR_RGB2GRAY)


def peak(values, exclusion=8):
    values = np.nan_to_num(values, nan=-1, posinf=-1, neginf=-1)
    index = int(np.argmax(values))
    best = float(values.flat[index])
    y, x = np.unravel_index(index, values.shape)
    other = values.copy()
    other[max(0, y-exclusion):y+exclusion+1,
          max(0, x-exclusion):x+exclusion+1] = -1
    return int(x), int(y), best, float(other.max())


def slide(request):
    bg, part = image(request["background"]), image(request["piece"])
    scale = float(request.get("pieceScale", 1))
    if not math.isfinite(scale) or not 0.1 <= scale <= 4:
        raise Uncertain("invalid_piece_scale")
    if abs(scale-1) > 0.01:
        part = cv2.resize(part, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)
    alpha = part[:, :, 3]
    if np.min(alpha) < 128:
        coords = cv2.findNonZero((alpha > 64).astype(np.uint8))
        if coords is None:
            raise Uncertain("empty_piece")
        ox, oy, w, h = cv2.boundingRect(coords)
        part = part[oy:oy+h, ox:ox+w]
        mask = (part[:, :, 3] > 64).astype(np.uint8) * 255
    else:
        ox, oy = 0, 0
        h, w = part.shape[:2]
        mask = np.full((h, w), 255, np.uint8)
    if w >= bg.shape[1] or h >= bg.shape[0] or w < 10 or h < 10:
        raise Uncertain("invalid_piece")
    bgray, pgray = gray(bg), gray(part)
    bedge = cv2.Canny(bgray, 40, 120)
    pedge = cv2.Canny(pgray, 40, 120)
    # Matching gradients tolerates the darkening commonly applied to the gap.
    pedge[mask == 0] = 0
    silhouette = cv2.Canny(cv2.copyMakeBorder(mask, 1, 1, 1, 1,
                                            cv2.BORDER_CONSTANT), 40, 120)[1:-1, 1:-1]
    template = cv2.bitwise_or(pedge, silhouette)
    edges = cv2.matchTemplate(bedge, template, cv2.TM_CCORR_NORMED)
    distance = cv2.distanceTransform((bedge == 0).astype(np.uint8), cv2.DIST_L2, 3)
    nearby = np.exp(-distance*distance/(2*1.8*1.8)).astype(np.float32)
    boundary = (silhouette > 0).astype(np.float32)
    outline_score = cv2.matchTemplate(nearby, boundary, cv2.TM_CCORR)/max(1, np.count_nonzero(boundary))
    # Texture is useful when the provider supplies an unmodified background.
    texture = cv2.matchTemplate(bgray, pgray, cv2.TM_CCOEFF_NORMED, mask=mask)
    texture = np.nan_to_num(texture, nan=0, posinf=0, neginf=0)
    score = 0.85*outline_score + 0.15*np.maximum(texture, 0) if np.min(alpha) < 128 else np.maximum(edges, np.maximum(texture, 0)*0.94)
    start = float(request.get("pieceX", 0))
    minimum = max(12, int(start + ox + 10))
    score[:, :minimum] = -1
    if "pieceY" in request:
        expected = float(request["pieceY"]) + oy
        for y in range(score.shape[0]):
            if abs(y - expected) > 12:
                score[y] = -1
    x, y, best, second = peak(score)
    if best < 0.36 or best - second < 0.015:
        raise Uncertain("ambiguous_slide")
    target = x - ox
    if target <= start or target + w > bg.shape[1] + ox:
        raise Uncertain("invalid_slide")
    return {"kind": "slide", "x": target, "y": y-oy,
            "pieceWidth": w, "offsetX": ox, "confidence": min(0.99, best)}


def visible_radius(im):
    h, w = im.shape[:2]
    radius = min(h, w) / 2
    if np.min(im[:, :, 3]) < 128:
        yy, xx = np.where(im[:, :, 3] > 128)
        if len(xx) < 20:
            raise Uncertain("empty_ring")
        radius = float(np.percentile(np.hypot(xx-(w-1)/2, yy-(h-1)/2), 99))
    return radius


def ring(im, radius, inside):
    n = 720
    angle = np.arange(n, dtype=np.float32) * np.float32(2 * math.pi / n)
    h, w = im.shape[:2]
    samples = []
    for offset in (2, 4, 6):
        r = radius-offset if inside else radius+offset
        mx = ((w-1)/2 + r * np.cos(angle)).reshape(1, -1)
        my = ((h-1)/2 + r * np.sin(angle)).reshape(1, -1)
        samples.append(cv2.remap(im[:, :, :3].astype(np.float32), mx, my,
                                cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)[0])
    values = np.mean(samples, axis=0)
    values -= values.mean(axis=0)
    scale = float(np.linalg.norm(values))
    if scale < 150:
        raise Uncertain("featureless_rotation")
    return values / scale


def rotate(request):
    outer, inner = image(request["background"]), image(request["piece"])
    ratio = float(request.get("pieceScale", 1))
    if not math.isfinite(ratio) or not 0.1 <= ratio <= 4:
        raise Uncertain("invalid_ring_scale")
    radius = visible_radius(inner)
    seam = radius * ratio
    if not 12 <= seam < min(outer.shape[:2])/2-6:
        raise Uncertain("invalid_ring_geometry")
    a, b = ring(outer, seam, False), ring(inner, radius, True)
    # Circular correlation uses only pixels immediately beside the seam.
    correlation = np.zeros(720)
    for channel in range(3):
        correlation += np.fft.irfft(np.fft.rfft(a[:, channel]) *
                                   np.conj(np.fft.rfft(b[:, channel])), n=720)
    best_index = int(np.argmax(correlation))
    best = float(correlation[best_index])
    other = correlation.copy()
    for shift in range(-16, 17):
        other[(best_index+shift) % 720] = -1
    if best < 0.35 or best - float(other.max()) < 0.012:
        raise Uncertain("ambiguous_rotation")
    return {"kind": "rotate", "angle": best_index/2,
            "confidence": min(0.99, best)}


@lru_cache(maxsize=2)
def ocr(det=False):
    import ddddocr
    # The bundled ONNX models stay on the CPU and are never fetched at runtime.
    return ddddocr.DdddOcr(ocr=not det, det=det, show_ad=False)


def foreground(im):
    if np.min(im[:, :, 3]) < 128:
        return (im[:, :, 3] > 128).astype(np.uint8) * 255
    g = gray(im)
    border = np.concatenate([g[0], g[-1], g[:, 0], g[:, -1]])
    diff = cv2.absdiff(g, np.full_like(g, int(np.median(border))))
    _, mask = cv2.threshold(diff, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return mask


def boxes(im):
    h, w = im.shape[:2]
    found = []
    try:
        found.extend(ocr(True).detection(png(im)))
    except Exception:
        pass
    mask = cv2.morphologyEx(foreground(im), cv2.MORPH_CLOSE,
                          np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        if cv2.contourArea(contour) >= 35:
            found.append([x, y, x+cw, y+ch])
    out = []
    for raw in found:
        x1, y1, x2, y2 = [int(v) for v in raw]
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
        if not (10 <= x2-x1 <= w*0.6 and 10 <= y2-y1 <= h*0.85):
            continue
        area = (x2-x1)*(y2-y1)
        duplicate = False
        for a, b, c, d in out:
            overlap = max(0, min(c, x2)-max(a, x1))*max(0, min(d, y2)-max(b, y1))
            if overlap / min(area, (c-a)*(d-b)) > 0.65:
                duplicate = True
                break
        if not duplicate:
            out.append([x1, y1, x2, y2])
    return out[:24]


def target_text(instruction):
    if not isinstance(instruction, str) or len(instruction) > 300:
        return []
    quoted = re.findall(r'[“"‘\'【]([^”"’\'】]{1,12})[”"’\'】]', instruction)
    if quoted:
        text = "".join(quoted)
    else:
        match = re.search(r'(?:依次|顺序).*?(?:点击|点选|选择)\s*[:：]?\s*([\w\s、，,]{1,20})', instruction)
        text = match.group(1) if match else ""
        if any(word in text for word in ("图片", "图形", "文字", "下图", "以下", "图中")):
            return []
    chars = [c for c in text if c.isalnum()]
    return chars if 1 <= len(chars) <= 8 else []


def normalize_mask(im):
    mask = foreground(im)
    points = cv2.findNonZero(mask)
    if points is None:
        raise Uncertain("empty_target")
    x, y, w, h = cv2.boundingRect(points)
    crop = mask[y:y+h, x:x+w]
    size = max(w, h) + 8
    square = np.zeros((size, size), np.uint8)
    dx, dy = (size-w)//2, (size-h)//2
    square[dy:dy+h, dx:dx+w] = crop
    return cv2.resize(square, (64, 64), interpolation=cv2.INTER_NEAREST)


def shape_score(a, b):
    ma, mb = normalize_mask(a), normalize_mask(b)
    ca, _ = cv2.findContours(ma, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cb, _ = cv2.findContours(mb, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not ca or not cb:
        return 0
    distance = cv2.matchShapes(max(ca, key=cv2.contourArea),
                               max(cb, key=cv2.contourArea), cv2.CONTOURS_MATCH_I1, 0)
    moment = 1 / (1 + 5*distance)
    overlap = 0
    for angle in range(0, 360, 15):
        matrix = cv2.getRotationMatrix2D((31.5, 31.5), angle, 1)
        rotated = cv2.warpAffine(ma, matrix, (64, 64), flags=cv2.INTER_NEAREST)
        union = np.count_nonzero((rotated > 0) | (mb > 0))
        if union:
            overlap = max(overlap, np.count_nonzero((rotated > 0) & (mb > 0))/union)
    return 0.45*moment + 0.55*overlap


def assign(scores):
    states = {0: (0.0, [])}
    for row in scores:
        following = {}
        for mask, (total, chosen) in states.items():
            for index, score in enumerate(row):
                if mask & (1 << index) or score < 0.52:
                    continue
                key = mask | (1 << index)
                if key not in following or total+score > following[key][0]:
                    following[key] = (total+score, chosen+[index])
        if not following:
            raise Uncertain("unrecognized_targets")
        states = dict(sorted(following.items(), key=lambda item: item[1][0], reverse=True)[:512])
    ranked = sorted(states.values(), key=lambda entry: entry[0], reverse=True)
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 0.05:
        raise Uncertain("ambiguous_targets")
    return ranked[0][1]


def click(request):
    bg = image(request["background"])
    candidates = boxes(bg)
    if not candidates:
        raise Uncertain("no_targets_detected")
    crops = [bg[max(0, y1-6):min(bg.shape[0], y2+6), max(0, x1-6):min(bg.shape[1], x2+6)]
             for x1, y1, x2, y2 in candidates]
    targets = target_text(request.get("instruction", ""))
    templates = [image(item) for item in request.get("targets", [])[:8]]
    if not targets and not templates and request.get("prompt"):
        prompt = image(request["prompt"])
        templates = [prompt[y1:y2, x1:x2] for x1, y1, x2, y2 in
                     sorted(boxes(prompt), key=lambda b: b[0])[:8]]
    if targets:
        scores = [[0.0] * len(candidates) for _ in targets]
        for index, crop in enumerate(crops):
            for angle in (0, -25, 25, -45, 45):
                pil = Image.fromarray(crop).rotate(angle, expand=True, fillcolor="white")
                result = re.sub(r'\s', '', ocr().classification(png(np.asarray(pil))))
                for ti, target in enumerate(targets):
                    if result == target:
                        scores[ti][index] = max(scores[ti][index], 0.9 if angle == 0 else 0.8)
    elif templates:
        scores = [[shape_score(target, candidate) for candidate in crops] for target in templates]
    else:
        raise Uncertain("missing_click_instruction")
    if len(scores) > len(candidates):
        raise Uncertain("missing_targets")
    chosen = assign(scores)
    confidence = min(scores[i][index] for i, index in enumerate(chosen))
    points = [{"x": (candidates[index][0]+candidates[index][2])/2,
               "y": (candidates[index][1]+candidates[index][3])/2} for index in chosen]
    return {"kind": "click", "points": points, "confidence": confidence}


def solve(request):
    if not isinstance(request, dict) or request.get("kind") not in ("slide", "rotate", "click"):
        raise Uncertain("unsupported_type")
    result = {"slide": slide, "rotate": rotate, "click": click}[request["kind"]](request)
    for value in result.values():
        if isinstance(value, float) and not math.isfinite(value):
            raise Uncertain("invalid_result")
    return result


def main():
    import ddddocr
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        request = None
        try:
            if len(line) > MAX_REQUEST:
                raise Uncertain("request_too_large")
            request = json.loads(line)
            result = solve(request)
            print(json.dumps({"id": request.get("id"), "result": result}), flush=True)
        except Uncertain as error:
            print(json.dumps({"id": request.get("id") if isinstance(request, dict) else None,
                              "error": str(error)}), flush=True)
        except Exception:
            # Do not return images, model internals, paths, or library exceptions.
            print(json.dumps({"id": request.get("id") if isinstance(request, dict) else None,
                              "error": "local_recognition_failed"}), flush=True)


if __name__ == "__main__":
    main()
