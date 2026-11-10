#!/usr/bin/env python3
"""Turn a headshot into the ASCII portrait shown on the terminal card.

Usage:
    python scripts/portrait.py PHOTO [--cols 40] [--rows 21] [--zoom 2.7]
                                     [--face x,y,w,h] [--no-mask] [--preview preview.png]

Writes assets/portrait-dark.txt (bright areas drawn dense, for dark backgrounds)
and assets/portrait-light.txt (dark areas drawn dense, for light backgrounds).
Only the ASCII output lands in the repository; the photo stays where it is.

Each character is picked by shape, not just brightness: every printable ASCII
glyph is rendered into a cell, both glyphs and image are blurred slightly, and
the glyph closest to each image cell wins. Edges therefore come out as / \\ | _
instead of a flat density ramp.
"""

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FONT_CANDIDATES = [
    "C:/Windows/Fonts/consola.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
]
# The card draws 16px text on a 20px line, so a cell is about 2.2x taller than wide.
CELL_W, CELL_H = 11, 24
BLUR_SIGMA = 1.6
CHARSET = [chr(c) for c in range(32, 127)]


def load_font(path):
    for candidate in [path] if path else FONT_CANDIDATES:
        if candidate and Path(candidate).exists():
            probe = ImageFont.truetype(candidate, 100)
            advance = probe.getlength("M") / 100
            return ImageFont.truetype(candidate, round(CELL_W / advance))
    raise SystemExit("No monospace font found; pass --font.")


def glyph_bank(font):
    ascent, descent = font.getmetrics()
    top = (CELL_H - (ascent + descent)) // 2
    bank = []
    for ch in CHARSET:
        img = Image.new("L", (CELL_W, CELL_H), 0)
        ImageDraw.Draw(img).text((0, top), ch, fill=255, font=font)
        glyph = np.asarray(img, np.float32) / 255
        glyph = cv2.GaussianBlur(glyph, (0, 0), BLUR_SIGMA, borderType=cv2.BORDER_CONSTANT)
        bank.append(glyph.ravel())
    return np.stack(bank)


def find_face(gray):
    """Largest frontal face as (x, y, w, h); a centered guess when detection fails."""
    h, w = gray.shape
    # OpenCV 5 dropped the bundled Haar cascades; pass --face there instead.
    if hasattr(cv2, "CascadeClassifier"):
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        side = min(h, w)
        faces = cascade.detectMultiScale(gray, 1.1, 6, minSize=(side // 8, side // 8))
        if len(faces):
            return tuple(int(v) for v in max(faces, key=lambda f: f[2] * f[3]))
    print("No face detected; assuming a centered headshot (pass --face x,y,w,h to fix).")
    return w // 3, h // 4, w // 3, w // 3


def crop_portrait(bgr, face, cols, rows, zoom, raise_by):
    """Crop around the face so the head fills the upper part of the frame."""
    x, y, w, h = face
    aspect = cols * CELL_W / (rows * CELL_H)
    crop_h = int(zoom * h)
    crop_w = int(crop_h * aspect)
    left = int(x + w / 2 - crop_w / 2)
    top = int(y - raise_by * h)

    # Replicate the border so crops that run past the photo edge stay valid;
    # `inside` marks real pixels so padding never counts as subject.
    pad = max(crop_h, crop_w)
    padded = cv2.copyMakeBorder(bgr, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
    inside = np.zeros(padded.shape[:2], np.uint8)
    inside[pad:pad + bgr.shape[0], pad:pad + bgr.shape[1]] = 1
    y0, x0 = top + pad, left + pad
    window = (slice(y0, y0 + crop_h), slice(x0, x0 + crop_w))
    return padded[window].copy(), inside[window].copy(), (x - left, y - top, w, h)


def subject_mask(crop, inside, face):
    """Separate head and shoulders from the background with GrabCut."""
    h, w = crop.shape[:2]
    fx, fy, fw, fh = face
    mask = np.full((h, w), cv2.GC_PR_BGD, np.uint8)
    head = (int(fx + fw / 2), int(fy + fh * 0.4))
    cv2.ellipse(mask, head, (int(fw * 0.72), int(fh * 0.95)), 0, 0, 360, cv2.GC_PR_FGD, -1)
    cv2.rectangle(mask, (int(fx - fw * 0.7), int(fy + fh * 1.15)), (int(fx + fw * 1.7), h), cv2.GC_PR_FGD, -1)
    cv2.rectangle(mask, (int(fx + fw * 0.2), int(fy + fh * 0.25)), (int(fx + fw * 0.8), int(fy + fh * 0.9)), cv2.GC_FGD, -1)
    # Upper corners of a headshot are background, and so is any padding.
    mask[: h // 5, : w // 7] = cv2.GC_BGD
    mask[: h // 5, -(w // 7):] = cv2.GC_BGD
    mask[inside == 0] = cv2.GC_BGD

    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(crop, mask, None, bgd, fgd, 6, cv2.GC_INIT_WITH_MASK)
    fg = np.isin(mask, (cv2.GC_FGD, cv2.GC_PR_FGD)).astype(np.uint8)

    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(fg)
    if count > 1:
        fg = (labels == 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    # Fill holes (glasses glare, teeth) by flooding the background from a corner.
    flood = fg.copy()
    cv2.floodFill(flood, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 1)
    fg = fg | (1 - flood)
    return cv2.GaussianBlur(fg.astype(np.float32), (0, 0), 1.5)


def tone(crop, mask, gamma):
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(6, 6)).apply(gray).astype(np.float32)
    lo, hi = np.percentile(gray[mask > 0.5], [2, 98])
    return np.clip((gray - lo) / max(hi - lo, 1.0), 0, 1) ** gamma


def edges(crop, mask, sigma=1.0):
    """Gradient magnitude scaled to [0, 1], so glasses, eyes and jaw stay visible."""
    gray = cv2.GaussianBlur(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255, (0, 0), sigma)
    mag = np.hypot(cv2.Sobel(gray, cv2.CV_32F, 1, 0), cv2.Sobel(gray, cv2.CV_32F, 0, 1))
    return np.clip(mag / max(np.percentile(mag[mask > 0.5], 97), 1e-6), 0, 1)


def to_ascii(ink, cols, rows, bank, density, tone_weight):
    img = cv2.resize(ink, (cols * CELL_W, rows * CELL_H), interpolation=cv2.INTER_AREA)
    img = cv2.GaussianBlur(img, (0, 0), BLUR_SIGMA)
    cells = img.reshape(rows, CELL_H, cols, CELL_W).transpose(0, 2, 1, 3).reshape(rows * cols, -1)
    means = bank.mean(axis=1)
    # Push full ink past the densest glyph so solid areas read as solid.
    cells = cells * means.max() * density
    dist = (cells**2).sum(1)[:, None] - 2 * cells @ bank.T + (bank**2).sum(1)[None, :]
    # Shape matching alone favors thin glyphs; also penalize a mismatch in overall darkness.
    dist += tone_weight * cells.shape[1] * (cells.mean(axis=1)[:, None] - means[None, :]) ** 2
    chars = np.array(CHARSET)[dist.argmin(axis=1)].reshape(rows, cols)
    return ["".join(row) for row in chars]


def render_preview(dark, light, font_path, out):
    font = ImageFont.truetype(font_path, 14)
    advance = font.getlength("M")
    line = 18
    width = int(advance * len(dark[0])) + 32
    height = line * len(dark) + 32
    canvas = Image.new("RGB", (width * 2, height))
    for i, (lines, bg, fg) in enumerate([(dark, "#161b22", "#c9d1d9"), (light, "#f6f8fa", "#24292f")]):
        panel = Image.new("RGB", (width, height), bg)
        draw = ImageDraw.Draw(panel)
        for r, text in enumerate(lines):
            draw.text((16, 16 + r * line), text, fill=fg, font=font)
        canvas.paste(panel, (i * width, 0))
    canvas.save(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("photo")
    parser.add_argument("--cols", type=int, default=40)
    parser.add_argument("--rows", type=int, default=21, help="matches the info column on the card")
    parser.add_argument("--zoom", type=float, default=2.7, help="crop height in face heights")
    parser.add_argument("--raise-by", type=float, default=0.45, help="headroom above the face, in face heights")
    parser.add_argument("--floor", type=float, default=0.1, help="minimum ink inside the subject")
    parser.add_argument("--gamma", type=float, default=0.8, help="below 1 brightens midtones")
    parser.add_argument("--edge", type=float, default=0.0, help="weight of the edge map (0.5 sharpens features)")
    parser.add_argument("--blur", type=float, default=1.0, help="soften facial detail, in character cells")
    parser.add_argument("--density", type=float, default=1.4, help="ink multiplier before glyph matching")
    parser.add_argument("--tone-weight", type=float, default=4.0, help="how much overall darkness counts")
    parser.add_argument("--face", help="face box in photo pixels as x,y,w,h (skips detection)")
    parser.add_argument("--no-mask", action="store_true", help="keep the background")
    parser.add_argument("--font")
    parser.add_argument("--preview", help="write a PNG preview of both variants here")
    args = parser.parse_args()

    photo = ImageOps.exif_transpose(Image.open(args.photo)).convert("RGB")
    bgr = cv2.cvtColor(np.asarray(photo), cv2.COLOR_RGB2BGR)
    if args.face:
        face = tuple(int(v) for v in args.face.split(","))
    else:
        face = find_face(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY))
    crop, inside, face_in_crop = crop_portrait(bgr, face, args.cols, args.rows, args.zoom, args.raise_by)
    mask = inside.astype(np.float32) if args.no_mask else subject_mask(crop, inside, face_in_crop)
    level = tone(crop, mask, args.gamma)
    # Blur is given in character cells so it means the same at any photo resolution.
    sigma = args.blur * crop.shape[1] / args.cols
    if sigma > 0:
        level = cv2.GaussianBlur(level, (0, 0), sigma)
    outline = args.edge * edges(crop, mask, max(1.0, sigma))

    font = load_font(args.font)
    bank = glyph_bank(font)

    def draw(base):
        ink = mask * np.maximum(args.floor + (1 - args.floor) * base, outline)
        return to_ascii(ink, args.cols, args.rows, bank, args.density, args.tone_weight)

    dark = draw(level)  # bright areas dense
    light = draw(1 - level)  # dark areas dense

    ASSETS.mkdir(exist_ok=True)
    for name, lines in (("portrait-dark.txt", dark), ("portrait-light.txt", light)):
        (ASSETS / name).write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    if args.preview:
        render_preview(dark, light, font.path, args.preview)
    print(f"Wrote {args.rows}x{args.cols} portraits to {ASSETS}")


if __name__ == "__main__":
    main()
