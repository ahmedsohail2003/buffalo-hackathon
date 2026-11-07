#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["python-pptx==1.0.2"]
# ///
"""Build the STARHAND pitch deck: slides/STARHAND.pptx (16:9), optionally slides/STARHAND.pdf.

    python3 slides/build_deck.py          # write the .pptx
    python3 slides/build_deck.py --pdf    # also export the .pdf with LibreOffice

Re-run it whenever a screenshot lands in slides/screenshots/ (see slides/README.md):
bay.png fills slide 4; teleop.png and fabricator.png fill backup slides 11 and 12.
A missing screenshot gets a placeholder that names its path.
Presenter notes are copied from slides/SPEAKER-NOTES.md ("### Slide N" sections).
Asteroid silhouettes are traced from the NASA shape models in public/assets/samples/.
Everything is drawn with python-pptx shapes; no external images are needed.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import shutil
import subprocess
import sys
import tempfile
from functools import lru_cache
from pathlib import Path

from lxml import etree
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_LINE_DASH_STYLE
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = HERE / "STARHAND.pptx"
SHOTS = HERE / "screenshots"
SAMPLES = REPO / "public" / "assets" / "samples"
NOTES_MD = HERE / "SPEAKER-NOTES.md"

# ---------------------------------------------------------------------------------------------
# Facts you may need to edit before judging
# ---------------------------------------------------------------------------------------------
PRESENTER = "Ahmed Sohail Butt"
LINKS = [  # (label, text shown, URL). Text that starts with "<" is drawn in amber: still to fill.
    ("REPO", "github.com/ahmedsohail2003/buffalo-hackathon", "https://github.com/ahmedsohail2003/buffalo-hackathon"),
    ("LIVE", "<live URL on Vultr>", None),
    ("VIDEO", "<YouTube link>", None),
]
# Measured in the integrated app with SO-101 limits. Update these if the Fabricator changes.
LIMITS = [("grip", "15–45 mm"), ("height", "≤ 45 mm"), ("mass", "≤ 90 g"), ("footprint", "≤ 60 mm")]
SCALED = {"name": "Iron meteorite", "designed": "38 mm, 204 g", "verdict": "too heavy", "scale": "×0.76",
          "result": "28.9 mm grip, 19 mm tall, 90 g"}
REFUSED = {"name": "Antenna boom",
           "reason": "too tall and thin… make it at least 40 mm across, or no taller than 11 mm"}
BENNU = {"grip_mm": 29.6, "height_mm": 31, "mass_g": 15}
ARM = {"reach": "130–200 MM", "hover": "60 MM", "fk_check": "< 4e-8 m"}

# Screenshots in slides/screenshots/ (.png or .jpg). Missing files get a placeholder.
#   stem: (slide title, lower-third caption or None, what the screenshot shows)
SCREENSHOTS = {
    "bay": ("Live demo", None, "the bay view"),
    "teleop": ("Teleop", "Your hand sets where. A pinch says when. No hand: the arm holds.",
               "the hand pane next to the bay"),
    "fabricator": ("Fabricator", "Gemini designs it. Code measures it, then scales it or refuses.",
                   "a Fabricator result card"),
}

# ---------------------------------------------------------------------------------------------
# Look
# ---------------------------------------------------------------------------------------------
SANS = "Inter"            # falls back to the viewer's default sans if Inter is not installed
MONO = "JetBrains Mono"   # numbers, labels, code
BG, PANEL, BORDER = "05070D", "0B1220", "1C2A3F"
CYAN, AMBER, TEXT, MUTED = "38BDF8", "F59E0B", "E2E8F0", "8AA0BF"
CYAN_DEEP, AMBER_DEEP = "0C2536", "2A1C05"

W, H = 13.333, 7.5        # slide size, inches (16:9)
M = 0.6                   # side margin
R = W - M                 # right content edge
TOTAL = 10                # main slides, shown in kickers; two backup screenshot slides follow

FIT_WARNINGS: list[str] = []


# ---------------------------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------------------------
def rgb(hex_: str) -> RGBColor:
    return RGBColor.from_string(hex_)


def E(inches: float) -> Emu:
    return Emu(int(round(inches * 914400)))


def _no_shadow(shape) -> None:
    try:
        shape.shadow.inherit = False
    except (AttributeError, NotImplementedError):
        pass


def _set_alpha(shape, alpha: float) -> None:
    """Make a shape's solid fill partly transparent (alpha 0-1)."""
    solid = shape._element.spPr.find(qn("a:solidFill"))
    if solid is not None and len(solid):
        a = etree.SubElement(solid[0], qn("a:alpha"))
        a.set("val", str(int(alpha * 100000)))


def _fill_line(shape, fill, line, lw, dash=None, alpha=None) -> None:
    if fill is None:
        shape.fill.background()
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = rgb(fill)
        if alpha is not None:
            _set_alpha(shape, alpha)
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = rgb(line)
        shape.line.width = Pt(lw)
        if dash:
            shape.line.dash_style = dash
    _no_shadow(shape)


def _gradient(shape, stops, angle_deg: float) -> None:
    """Linear gradient. stops = [(pos 0-1, hex)], angle clockwise from left-to-right."""
    shape.fill.gradient()
    grad = shape._element.spPr.find(qn("a:gradFill"))
    gs_lst = grad.find(qn("a:gsLst"))
    for child in list(gs_lst):
        gs_lst.remove(child)
    for pos, hex_ in stops:
        gs = etree.SubElement(gs_lst, qn("a:gs"))
        gs.set("pos", str(int(pos * 100000)))
        etree.SubElement(gs, qn("a:srgbClr")).set("val", hex_)
    lin = grad.find(qn("a:lin"))
    if lin is None:
        lin = etree.SubElement(grad, qn("a:lin"))
    lin.set("ang", str(int(angle_deg * 60000)))
    lin.set("scaled", "0")


def _name(shape, name: str | None, descr: str | None = None) -> None:
    c_nv_pr = shape._element.find(".//" + qn("p:cNvPr"))
    if c_nv_pr is None:
        return
    if name:
        c_nv_pr.set("name", name)
    if descr:
        c_nv_pr.set("descr", descr)


def bring_to_front(shape) -> None:
    el = shape._element
    tree = el.getparent()
    tree.remove(el)
    tree.append(el)


def send_to_back(shape) -> None:
    el = shape._element
    tree = el.getparent()
    tree.remove(el)
    tree.insert(2, el)  # after nvGrpSpPr and grpSpPr


# ---------------------------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------------------------
def Rn(text, size, color=TEXT, font=SANS, bold=False, spc=0.0, link=None):
    """One text run."""
    return {"text": text, "size": size, "color": color, "font": font, "bold": bold, "spc": spc, "link": link}


def Pa(*runs, align="l", after=0, ls=1.0):
    """One paragraph made of runs."""
    return {"runs": list(runs), "align": align, "after": after, "ls": ls}


_ALIGN = {"l": PP_ALIGN.LEFT, "c": PP_ALIGN.CENTER, "r": PP_ALIGN.RIGHT}
_ANCHOR = {"t": MSO_ANCHOR.TOP, "m": MSO_ANCHOR.MIDDLE, "b": MSO_ANCHOR.BOTTOM}


def _write_runs(tf, paras, anchor="t") -> None:
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = _ANCHOR[anchor]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = _ALIGN[para["align"]]
        p.line_spacing = para["ls"]
        if para["after"]:
            p.space_after = Pt(para["after"])
        for run in para["runs"]:
            for j, part in enumerate(run["text"].split("\n")):  # "\n" inside a run = line break
                if j:
                    p.add_line_break()
                _add_run(p, part, run)


def _add_run(p, s, run) -> None:
    r = p.add_run()
    r.text = s
    f = r.font
    f.size = Pt(run["size"])
    f.bold = run["bold"]
    f.color.rgb = rgb(run["color"])
    f.name = run["font"]
    r_pr = r._r.get_or_add_rPr()
    prev = r_pr.find(qn("a:latin"))
    for tag in ("a:ea", "a:cs"):  # same face for symbols such as arrows
        el = etree.Element(qn(tag))
        el.set("typeface", run["font"])
        prev.addnext(el)
        prev = el
    if run["spc"]:
        r_pr.set("spc", str(int(run["spc"] * 100)))
    if run["link"]:
        r.hyperlink.address = run["link"]


def text(shapes, x, y, w, h, *paras, anchor="t", name=None):
    box = shapes.add_textbox(E(x), E(y), E(w), E(h))
    _write_runs(box.text_frame, paras, anchor)
    _name(box, name)
    _check_fit(paras, w, h, name or (paras[0]["runs"][0]["text"][:40] if paras and paras[0]["runs"] else "text"))
    return box


def label(shapes, x, y, w, h, s, size, color=TEXT, font=SANS, bold=False, spc=0.0, align="l", anchor="t"):
    return text(shapes, x, y, w, h, Pa(Rn(s, size, color, font, bold, spc), align=align), anchor=anchor)


def set_title(slide, x, y, w, h, *runs, align="l", anchor="t"):
    t = slide.shapes.title
    t.left, t.top, t.width, t.height = E(x), E(y), E(w), E(h)
    tf = t.text_frame
    tf.clear()
    _write_runs(tf, [Pa(*runs, align=align)], anchor)
    _check_fit([Pa(*runs)], w, h, "title: " + "".join(r["text"] for r in runs))
    return t


# ---- rough text-fit lint (uses the real font files when fontconfig can find them) ----------
@lru_cache(maxsize=None)
def _font_file(face: str, bold: bool) -> str | None:
    if not shutil.which("fc-match"):
        return None
    try:
        out = subprocess.run(["fc-match", "-f", "%{file}|%{family}", f"{face}:{'bold' if bold else 'regular'}"],
                             capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    path, _, family = out.partition("|")
    return path if face.lower() in family.lower() else None


@lru_cache(maxsize=None)
def _pil_font(face: str, bold: bool):
    path = _font_file(face, bold)
    try:
        return ImageFont.truetype(path, 1000, layout_engine=ImageFont.Layout.BASIC) if path else None
    except OSError:
        return None


def _run_width_in(run) -> float | None:
    f = _pil_font(run["font"], run["bold"])
    if f is None:
        return None
    s = run["text"].replace("\n", "")
    try:
        return (f.getlength(s) * run["size"] / 1000 + run["spc"] * max(len(s) - 1, 0)) / 72
    except (OSError, RuntimeError, ValueError):
        return None


def _check_fit(paras, w, h, what) -> None:
    total_h = 0.0
    for para in paras:
        runs = para["runs"]
        if not runs:
            continue
        widths = [_run_width_in(r) for r in runs]
        if any(x is None for x in widths):
            return  # fonts not measurable here; skip the lint
        size = max(r["size"] for r in runs)
        lines = 1
        # greedy wrap on words, using the average width per character of each run
        x = 0.0
        for r, rw in zip(runs, widths):
            per_char = rw / max(len(r["text"].replace("\n", "")), 1)
            for word in re.split(r"(\n|[ \t]+)", r["text"]):
                if word == "\n":
                    lines += 1
                    x = 0.0
                    continue
                ww = per_char * len(word)
                if x + ww > w * 1.001 and x > 0 and not word.isspace():
                    lines += 1
                    x = ww
                    if ww > w * 1.001:
                        FIT_WARNINGS.append(f"word wider than box ({ww:.2f} > {w:.2f} in): {word!r} in {what!r}")
                else:
                    x += ww
        total_h += lines * size * 1.21 * para["ls"] / 72 + para["after"] / 72
    if total_h > h * 1.04 + 0.02:
        FIT_WARNINGS.append(f"text may overflow ({total_h:.2f} > {h:.2f} in tall): {what!r}")


# ---------------------------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------------------------
def rect(shapes, x, y, w, h, fill=None, line=None, lw=1.0, kind=MSO_SHAPE.RECTANGLE, adj=None,
         dash=None, alpha=None, name=None):
    s = shapes.add_shape(kind, E(x), E(y), E(w), E(h))
    if adj is not None:
        s.adjustments[0] = adj
    _fill_line(s, fill, line, lw, dash, alpha)
    _name(s, name)
    return s


def panel(shapes, x, y, w, h, fill=PANEL, line=BORDER, lw=1.0, snip=0.22, dash=None, name=None):
    """A mission-control panel: one snipped corner (top right)."""
    return rect(shapes, x, y, w, h, fill, line, lw, MSO_SHAPE.SNIP_1_RECTANGLE, snip / min(w, h), dash, name=name)


def pill(shapes, x, y, w, h, fill=None, line=CYAN, lw=1.25, runs=(), dash=None, alpha=None, name=None):
    s = rect(shapes, x, y, w, h, fill, line, lw, MSO_SHAPE.ROUNDED_RECTANGLE, 0.5, dash, alpha, name)
    if runs:
        _write_runs(s.text_frame, [Pa(*runs, align="c")], "m")
    return s


def circle(shapes, cx, cy, d, fill=None, line=None, lw=1.0, alpha=None, name=None):
    return rect(shapes, cx - d / 2, cy - d / 2, d, d, fill, line, lw, MSO_SHAPE.OVAL, alpha=alpha, name=name)


def seg(shapes, x1, y1, x2, y2, color=CYAN, lw=1.5, dash=None, head=False, tail=False, cap="rnd"):
    """Straight line; tail=True puts an arrowhead at (x2, y2), head=True at (x1, y1)."""
    c = shapes.add_connector(MSO_CONNECTOR.STRAIGHT, E(x1), E(y1), E(x2), E(y2))
    c.line.color.rgb = rgb(color)
    c.line.width = Pt(lw)
    if dash:
        c.line.dash_style = dash
    ln = c.line._get_or_add_ln()
    ln.set("cap", cap)
    for flag, tag in ((head, "a:headEnd"), (tail, "a:tailEnd")):
        if flag:
            end = etree.SubElement(ln, qn(tag))
            end.set("type", "triangle")
            end.set("w", "med")
            end.set("len", "med")
    return c


def poly(shapes, pts, closed=True, fill=None, line=CYAN, lw=1.5, name=None):
    fb = shapes.build_freeform(E(pts[0][0]), E(pts[0][1]), scale=1.0)
    fb.add_line_segments([(E(x), E(y)) for x, y in pts[1:]], close=closed)
    s = fb.convert_to_shape()
    _fill_line(s, fill, line, lw)
    _name(s, name)
    return s


def group(shapes, name=None):
    g = shapes.add_group_shape()
    _name(g, name)
    return g


def finish(g) -> None:
    """Freeforms do not update group extents on their own."""
    g.shapes._recalculate_extents()


def brackets(shapes, x, y, w, h, arm=0.32, color=CYAN, lw=1.75):
    """HUD corner brackets around a box: the deck's recurring motif."""
    g = group(shapes, "HUD brackets")
    for cx, cy, dx, dy in ((x, y, 1, 1), (x + w, y, -1, 1), (x, y + h, 1, -1), (x + w, y + h, -1, -1)):
        poly(g.shapes, [(cx + dx * arm, cy), (cx, cy), (cx, cy + dy * arm)], closed=False, line=color, lw=lw)
    finish(g)
    return g


def stars(shapes, n, seed, avoid=()):
    rnd = random.Random(seed)
    g = group(shapes, "Star field")
    placed = 0
    while placed < n:
        x, y = rnd.uniform(0.15, W - 0.15), rnd.uniform(0.15, H - 0.15)
        if any(ax <= x <= ax + aw and ay <= y <= ay + ah for ax, ay, aw, ah in avoid):
            continue
        d = rnd.choice((0.018, 0.022, 0.028, 0.036))
        color = rnd.choice((TEXT, TEXT, MUTED, CYAN))
        circle(g.shapes, x, y, d, fill=color, alpha=rnd.uniform(0.35, 0.9))
        placed += 1
    finish(g)
    return g


def chevron(shapes, cx, cy, w=0.26, h=0.44, color=CYAN):
    return rect(shapes, cx - w / 2, cy - h / 2, w, h, color, None, kind=MSO_SHAPE.CHEVRON, adj=0.55)


# ---------------------------------------------------------------------------------------------
# Real NASA shape models -> vector silhouettes
# ---------------------------------------------------------------------------------------------
VIEWS = {"bennu": "side", "itokawa": "side", "eros": "top", "kleopatra": "top"}


@lru_cache(maxsize=None)
def silhouette(name: str, view: str) -> tuple[tuple[float, float], ...]:
    """Outline of a shape model seen from one side, normalized so the larger extent is 1."""
    path = SAMPLES / f"{name}.json"
    if not path.exists():  # fallback: a lumpy blob, so the deck still builds without the assets
        rnd = random.Random(name)
        return tuple((0.5 + 0.5 * (0.86 + 0.14 * rnd.random()) * math.cos(t),
                      0.5 + 0.5 * (0.86 + 0.14 * rnd.random()) * math.sin(t))
                     for t in (i * 2 * math.pi / 28 for i in range(28)))
    d = json.loads(path.read_text(encoding="utf-8"))
    pos, idx = d["positions"], d["indices"]
    pts3 = [(pos[i], pos[i + 1], pos[i + 2]) for i in range(0, len(pos), 3)]
    if view == "side":       # look along +y; x right, z up
        p2 = [(x, -z) for x, y, z in pts3]
    elif view == "front":    # look along +x; y right, z up
        p2 = [(y, -z) for x, y, z in pts3]
    else:                    # top
        p2 = [(x, -y) for x, y, z in pts3]
    xs, ys = [p[0] for p in p2], [p[1] for p in p2]
    x0, y0 = min(xs), min(ys)
    span = max(max(xs) - x0, max(ys) - y0)
    n, pad = 520, 4
    s = (n - 2 * pad) / span
    q = [((x - x0) * s + pad, (y - y0) * s + pad) for x, y in p2]
    wpx, hpx = int((max(xs) - x0) * s) + 2 * pad + 1, int((max(ys) - y0) * s) + 2 * pad + 1
    mask = Image.new("L", (wpx, hpx), 0)
    draw = ImageDraw.Draw(mask)
    for t in range(0, len(idx), 3):
        draw.polygon([q[idx[t]], q[idx[t + 1]], q[idx[t + 2]]], fill=255)
    contour = _trace(mask)
    far = max(range(len(contour)), key=lambda i: (contour[i][0] - contour[0][0]) ** 2 + (contour[i][1] - contour[0][1]) ** 2)
    simple = _rdp(contour[: far + 1], 1.1)[:-1] + _rdp(contour[far:] + [contour[0]], 1.1)[:-1]
    norm = n - 2 * pad
    return tuple(((px - pad) / norm, (py - pad) / norm) for px, py in simple)


def _trace(mask: Image.Image) -> list[tuple[int, int]]:
    """Moore-neighbour trace of the outer boundary of the blob in a binary mask."""
    w, h = mask.size
    px = mask.load()

    def fg(x, y):
        return 0 <= x < w and 0 <= y < h and px[x, y] > 127

    start = next((x, y) for y in range(h) for x in range(w) if fg(x, y))
    dirs = [(-1, 0), (-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1)]
    cur, back, out = start, 0, [start]
    for _ in range(w * h):
        for i in range(1, 9):
            d = (back + i) % 8
            nx, ny = cur[0] + dirs[d][0], cur[1] + dirs[d][1]
            if fg(nx, ny):
                pd = (back + i - 1) % 8
                bx, by = cur[0] + dirs[pd][0], cur[1] + dirs[pd][1]
                cur, back = (nx, ny), dirs.index((bx - nx, by - ny))
                break
        else:
            break
        if cur == start:
            break
        out.append(cur)
    return out


def _rdp(pts, eps):
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy) or 1e-9
        best, bi = 0.0, -1
        for i in range(a + 1, b):
            x, y = pts[i]
            dist = abs(dy * (x - ax) - dx * (y - ay)) / length
            if dist > best:
                best, bi = dist, i
        if best > eps:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def asteroid(shapes, name, cx, cy, size, view=None, lw=1.5, line=CYAN):
    """Draw a silhouette whose larger extent is `size` inches, centred on (cx, cy)."""
    pts = silhouette(name, view or VIEWS.get(name, "side"))
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    bw, bh = (max(xs) - min(xs)) * size, (max(ys) - min(ys)) * size
    ox, oy = cx - bw / 2 - min(xs) * size, cy - bh / 2 - min(ys) * size
    s = poly(shapes, [(ox + x * size, oy + y * size) for x, y in pts], fill=PANEL, line=line, lw=lw,
             name=f"{name} silhouette")
    _gradient(s, [(0, "2A3A55"), (0.55, "111A2B"), (1, "070B14")], 45)
    _name(s, None, f"Silhouette of asteroid {name.title()} from the NASA shape model")
    return s, bw, bh


# ---------------------------------------------------------------------------------------------
# Glyphs (vector icons)
# ---------------------------------------------------------------------------------------------
HAND = [(0.50, 0.97), (0.33, 0.88), (0.21, 0.76), (0.12, 0.65), (0.04, 0.56),
        (0.34, 0.52), (0.30, 0.34), (0.28, 0.22), (0.26, 0.11),
        (0.49, 0.49), (0.49, 0.29), (0.49, 0.16), (0.49, 0.03),
        (0.63, 0.52), (0.66, 0.34), (0.68, 0.22), (0.70, 0.12),
        (0.76, 0.59), (0.82, 0.46), (0.86, 0.37), (0.90, 0.28)]
HAND_LINKS = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11),
              (11, 12), (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (17, 18), (18, 19), (19, 20), (0, 17)]


def hand_glyph(shapes, x, y, w, h):
    """MediaPipe's 21 hand landmarks, open palm."""
    g = group(shapes, "Hand landmarks glyph")
    pts = [(x + px * w, y + py * h) for px, py in HAND]
    for a, b in HAND_LINKS:
        seg(g.shapes, *pts[a], *pts[b], color=CYAN, lw=1.75)
    for i, (px, py) in enumerate(pts):
        tip = i in (4, 8, 12, 16, 20)
        circle(g.shapes, px, py, 0.085 if tip else 0.065, fill=TEXT if not tip else CYAN)
    finish(g)
    return g


def arm_glyph(shapes, x, y, w, h, lw=None):
    """Side view of an SO-101-style arm holding a sample."""
    g = group(shapes, "SO-101 arm glyph")
    lw = lw or max(3.0, w * 4.2)

    def P(px, py):
        return x + px * w, y + py * h

    seg(g.shapes, *P(0.0, 0.93), *P(1.0, 0.93), color=BORDER, lw=1.25)          # deck
    rect(g.shapes, *P(0.10, 0.80), 0.30 * w, 0.13 * h, fill=BORDER, line=CYAN, lw=1.0,
         kind=MSO_SHAPE.TRAPEZOID, adj=0.25)                                      # base
    joints = [P(0.25, 0.76), P(0.40, 0.22), P(0.80, 0.30), P(0.82, 0.52)]
    for a, b in zip(joints, joints[1:]):
        seg(g.shapes, *a, *b, color=CYAN, lw=lw)
    seg(g.shapes, *P(0.75, 0.58), *P(0.89, 0.58), color=CYAN, lw=lw * 0.55)       # jaw bridge
    seg(g.shapes, *P(0.75, 0.58), *P(0.75, 0.76), color=CYAN, lw=lw * 0.55)       # fixed jaw
    seg(g.shapes, *P(0.89, 0.58), *P(0.89, 0.76), color=CYAN, lw=lw * 0.55)       # moving jaw
    rect(g.shapes, *P(0.77, 0.65), 0.10 * w, 0.11 * h, fill=AMBER, line=None,
         kind=MSO_SHAPE.ROUNDED_RECTANGLE, adj=0.3)                               # sample
    for jx, jy in joints[:3]:
        circle(g.shapes, jx, jy, 0.085 * w, fill=BG, line=CYAN, lw=max(1.5, lw * 0.35))
    finish(g)
    return g


def caliper_glyph(shapes, cx, cy, size):
    """Gripper jaws around Bennu, labelled with the grip width measured in the app."""
    g = group(shapes, "Grip measurement glyph")
    shape, bw, bh = asteroid(g.shapes, "bennu", cx, cy, size, view="front")
    jaw_w, jaw_h = 0.13, bh * 1.12
    left, right = cx - bw / 2, cx + bw / 2
    for jx in (left - jaw_w - 0.02, right + 0.02):
        rect(g.shapes, jx, cy - jaw_h / 2, jaw_w, jaw_h, fill=BORDER, line=CYAN, lw=1.25,
             kind=MSO_SHAPE.ROUNDED_RECTANGLE, adj=0.3)
    dim_y = cy + jaw_h / 2 + 0.2
    seg(g.shapes, left, dim_y, right, dim_y, color=MUTED, lw=1.25, head=True, tail=True)
    finish(g)
    label(shapes, cx - 1.2, dim_y + 0.08, 2.4, 0.3, f"{BENNU['grip_mm']:g} mm", 13, CYAN, MONO, True, align="c")
    return g


def glovebox_glyph(shapes, x, y, w, h):
    g = group(shapes, "Glovebox glyph")
    rect(g.shapes, x, y, w, h, fill="0C1A2A", line=CYAN, lw=1.5, kind=MSO_SHAPE.ROUNDED_RECTANGLE, adj=0.08)
    rect(g.shapes, x + w * 0.1, y + h * 0.12, w * 0.8, h * 0.36, fill="12304A", line=None,
         kind=MSO_SHAPE.ROUNDED_RECTANGLE, adj=0.12)                              # window
    for px in (0.3, 0.7):
        circle(g.shapes, x + w * px, y + h * 0.7, h * 0.3, fill=BG, line=CYAN, lw=1.5)   # glove ports
    seg(g.shapes, x + w * 0.08, y + h + 0.06, x + w * 0.92, y + h + 0.06, color=BORDER, lw=2)
    finish(g)
    return g


def dataset_glyph(shapes, x, y, w, h):
    g = group(shapes, "Dataset glyph")
    for i in range(3):
        rect(g.shapes, x, y + i * h * 0.36, w, h * 0.26, fill=CYAN_DEEP, line=CYAN, lw=1.25,
             kind=MSO_SHAPE.ROUNDED_RECTANGLE, adj=0.5)
    finish(g)
    return g


def network_glyph(shapes, x, y, w, h):
    g = group(shapes, "Policy network glyph")
    layers = [[0.25, 0.75], [0.1, 0.5, 0.9], [0.5]]
    pts = [[(x + w * (i / 2), y + h * fy) for fy in col] for i, col in enumerate(layers)]
    for a, b in zip(pts, pts[1:]):
        for p in a:
            for q in b:
                seg(g.shapes, *p, *q, color=BORDER, lw=1.25)
    for col in pts:
        for px, py in col:
            circle(g.shapes, px, py, 0.13, fill=BG, line=CYAN, lw=1.5)
    finish(g)
    return g


# ---------------------------------------------------------------------------------------------
# Slide scaffolding
# ---------------------------------------------------------------------------------------------
def new_slide(prs):
    slide = prs.slides.add_slide(prs.slide_layouts[5])  # "Title Only": keeps a real slide title
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = rgb(BG)
    return slide


def header(slide, num, kicker, title):
    label(slide.shapes, M, 0.5, 9.0, 0.3, f"{num:02d} / {TOTAL:02d}   {kicker}", 12, CYAN, MONO, spc=2.5)
    set_title(slide, M, 0.8, W - 2 * M, 0.8, Rn(title, 36, TEXT, SANS, True))


def done(slide, notes):
    num = len(slide.part.package.presentation_part.presentation.slides)
    if notes.get(num):
        slide.notes_slide.notes_text_frame.text = notes[num]


# ---------------------------------------------------------------------------------------------
# Slides
# ---------------------------------------------------------------------------------------------
def s1_title(prs, notes):
    s = new_slide(prs)
    sh = s.shapes
    stars(sh, 120, 7, avoid=[(0.2, 1.2, 8.3, 5.5), (7.9, 5.6, 5.3, 0.65)])
    label(sh, 0.8, 1.6, 7.4, 0.35, "UB HACKING 2026  ·  DEEP-SPACE SAMPLE BAY", 13, CYAN, MONO, spc=3)
    set_title(s, 0.8, 1.98, 7.6, 1.45, Rn("STARHAND", 88, TEXT, SANS, True, spc=2))
    text(sh, 0.8, 3.55, 7.0, 1.15,
         Pa(Rn("Reach into a deep-space sample bay with your bare hand.", 28, TEXT), ls=1.05))
    text(sh, 0.8, 5.45, 7.0, 0.85,
         Pa(Rn(PRESENTER, 20, TEXT, SANS, True), after=4),
         Pa(Rn("UNIVERSITY AT BUFFALO  ·  NOV 7–8, 2026", 12, MUTED, MONO, spc=1.5)))
    # Bennu, from the real NASA shape model, inside HUD brackets
    bx, by, bw, bh = 8.55, 1.35, 4.15, 4.4
    asteroid(sh, "bennu", bx + bw / 2, by + bh / 2, 3.55, lw=1.75)
    brackets(sh, bx, by, bw, bh, arm=0.42)
    cxh, cyh = bx + bw / 2, by + bh / 2
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):          # lock-on crosshair
        seg(sh, cxh + dx * 0.12, cyh + dy * 0.12, cxh + dx * 0.3, cyh + dy * 0.3, color=CYAN, lw=1.25)
    label(sh, bx - 0.6, by + bh + 0.15, bw + 0.6, 0.3,
          f"BENNU · NASA SHAPE MODEL · {BENNU['height_mm']} MM · {BENNU['mass_g']} G", 11, MUTED, MONO,
          spc=1, align="r")
    done(s, notes)


def s2_problem(prs, notes):
    s = new_slide(prs)
    sh = s.shapes
    header(s, 2, "THE PROBLEM", "Nothing may touch Bennu")
    text(sh, M - 0.05, 1.95, 6.3, 1.85,
         Pa(Rn("121.6", 110, CYAN, MONO, True), Rn(" g", 56, MUTED, MONO, True)))
    text(sh, M, 3.85, 6.2, 0.95,
         Pa(Rn("of asteroid Bennu, returned to Earth by NASA's OSIRIS-REx", 24, TEXT), ls=1.05))
    # card 0: why contamination matters
    lw_ = 6.15
    panel(sh, M, 5.05, lw_, 1.55, name="Inside the sample card")
    label(sh, M + 0.3, 5.25, 4.0, 0.3, "INSIDE THE SAMPLE", 12, CYAN, MONO, True, spc=2)
    for i, (big, small) in enumerate((("5 of 5", "nucleobases"), ("14 of 20", "amino acids life uses"))):
        bx = M + 0.3 + i * 2.55
        label(sh, bx, 5.62, 2.5, 0.5, big, 26, TEXT, MONO, True)
        label(sh, bx, 6.1, 2.6, 0.35, small, 15, MUTED)
    # card 1: glovebox
    cx, cw = 7.15, R - 7.15
    panel(sh, cx, 1.95, cw, 2.05, name="Glovebox card")
    glovebox_glyph(sh, cx + 0.35, 2.4, 1.45, 1.0)
    label(sh, cx + 2.15, 2.25, cw - 2.4, 0.3, "SEALED GLOVEBOXES", 13, CYAN, MONO, True, spc=2)
    text(sh, cx + 2.15, 2.7, cw - 2.4, 1.15,
         Pa(Rn("NASA Johnson Space Center. Only clean tools touch it.", 20, TEXT), ls=1.05))
    # card 2: light delay
    panel(sh, cx, 4.25, cw, 2.35, name="Light delay card")
    ey, ex, mx = 5.0, cx + 0.8, R - 0.65
    circle(sh, ex, ey, 0.78, fill="0E2A3D", line=CYAN, lw=1.5, name="Earth")
    circle(sh, mx, ey, 0.3, fill="4A5A72", line=None, name="Moon")
    seg(sh, ex + 0.5, ey, mx - 0.26, ey, color=CYAN, lw=1.5, dash=MSO_LINE_DASH_STYLE.DASH, tail=True)
    label(sh, ex + 0.5, 4.38, mx - ex - 0.8, 0.6, "1.3 s", 34, AMBER, MONO, True, align="c")
    label(sh, ex - 0.6, 5.48, 1.2, 0.25, "EARTH", 10, MUTED, MONO, spc=1, align="c")
    label(sh, mx - 0.6, 5.48, 1.2, 0.25, "MOON", 10, MUTED, MONO, spc=1, align="c")
    text(sh, cx + 0.35, 5.85, cw - 0.6, 0.65,
         Pa(Rn("One-way light time. Remote hands need safe autonomy.", 18, TEXT), ls=1.05))
    label(sh, M, 6.95, 12.0, 0.25, "SOURCES: NASA OSIRIS-REX MISSION  ·  NASA JSC ASTROMATERIALS CURATION",
          10, MUTED, MONO, spc=1)
    done(s, notes)


def s3_what(prs, notes):
    s = new_slide(prs)
    sh = s.shapes
    header(s, 3, "WHAT IT DOES", "Sense → Understand → Act")
    gap, pad = 0.42, 0.28
    pw = (W - 2 * M - 2 * gap) / 3
    top, ph = 1.95, 4.98
    cols = [
        ("01  SENSE", ["Hand tracking, on-device", "Fixed bay camera"], "~30 HZ · 21 LANDMARKS"),
        ("02  UNDERSTAND", ["Gemini designs samples", "Code measures grip,\nheight, mass", "Robotics-ER checks the bay"],
         "ONE UNIFORM SCALE, OR REFUSE"),
        ("03  ACT", ["SO-101 follows your hand", "Pinch to pick, pinch to place"],
         f"REACH {ARM['reach']} · HOVER {ARM['hover']}"),
    ]
    for i, (head, lines, spec) in enumerate(cols):
        x = M + i * (pw + gap)
        panel(sh, x, top, pw, ph, name=head)
        gx, gy, gw = x + pad, top + 0.3, pw - 2 * pad
        if i == 0:
            hand_glyph(sh, gx + gw / 2 - 0.68, gy + 0.02, 1.36, 1.62)
        elif i == 1:
            caliper_glyph(sh, gx + gw / 2, gy + 0.62, 1.0)
        else:
            arm_glyph(sh, gx + gw / 2 - 0.95, gy + 0.02, 1.9, 1.65)
        label(sh, x + pad, top + 2.3, gw, 0.35, head, 14, CYAN, MONO, True, spc=2.5)
        text(sh, x + pad, top + 2.8, gw, 1.55,
             *[Pa(Rn(t, 17, TEXT), after=10, ls=1.05) for t in lines])
        label(sh, x + pad, top + ph - 0.44, gw, 0.28, spec, 11, MUTED, MONO, spc=0.5)
        if i < 2:
            chevron(sh, x + pw + gap / 2, top + ph / 2)
    done(s, notes)


def find_shot(stem: str) -> Path | None:
    return next((p for p in (SHOTS / f"{stem}{ext}" for ext in (".png", ".jpg", ".jpeg")) if p.exists()), None)


def screenshot_slide(prs, notes, stem):
    """A screenshot slide. Near-16:9 images fill the slide (excess cropped from the centre); other
    shapes are shown whole under the title. Without the file, a placeholder names the path."""
    title, caption, what = SCREENSHOTS[stem]
    s = new_slide(prs)
    sh = s.shapes
    shot = find_shot(stem)
    bottom = 6.3 if caption else 7.05  # keep the lower-third caption clear
    if shot:
        iw, ih = Image.open(shot).size
        img_ar, box_ar = iw / ih, W / H
        if abs(img_ar / box_ar - 1) <= 0.12:
            pic = sh.add_picture(str(shot), 0, 0, E(W), E(H))
            if img_ar > box_ar:
                pic.crop_left = pic.crop_right = (1 - box_ar / img_ar) / 2
            else:
                pic.crop_top = pic.crop_bottom = (1 - img_ar / box_ar) / 2
        else:
            bx, by, bw = 0.45, 1.75, W - 0.9
            k = min(bw / iw, (bottom - by) / ih)
            pw_, ph_ = iw * k, ih * k
            pic = sh.add_picture(str(shot), E(bx + (bw - pw_) / 2), E(by + (bottom - by - ph_) / 2), E(pw_), E(ph_))
            pic.line.color.rgb = rgb(BORDER)
            pic.line.width = Pt(1)
        _name(pic, f"{title} screenshot", f"Screenshot of STARHAND: {what}")
        send_to_back(pic)
    else:
        panel(sh, 0.35, 0.35, W - 0.7, H - 0.7, fill=PANEL, line="2A4A66", lw=1.25, snip=0.4,
              dash=MSO_LINE_DASH_STYLE.DASH, name="Screenshot placeholder")
        end = bottom - 0.4
        brackets(sh, 1.0, 1.9, W - 2.0, end - 1.9, arm=0.5, lw=2)
        mid = (1.9 + end) / 2
        label(sh, 2.0, mid - 0.95, W - 4.0, 0.35, "SCREENSHOT PLACEHOLDER", 14, MUTED, MONO, spc=4, align="c")
        label(sh, 2.0, mid - 0.5, W - 4.0, 0.7, f"screenshots/{stem}.png", 32, CYAN, MONO, True, align="c")
        text(sh, 2.0, mid + 0.35, W - 4.0, 0.8,
             Pa(Rn(f"Capture {what}, ideally at 16:9.", 16, MUTED), align="c", after=2),
             Pa(Rn("Save it at this path, then re-run build_deck.py.", 16, MUTED), align="c"))
    tw = _run_width_in(Rn(title, 28, TEXT, SANS, True)) or 0.2 * len(title)
    rect(sh, 0.75, 0.7, tw + 1.1, 0.8, fill=BG, line=CYAN, lw=1.25, kind=MSO_SHAPE.ROUNDED_RECTANGLE,
         adj=0.5, alpha=0.88, name=f"{title} chip")
    circle(sh, 1.15, 1.1, 0.2, fill=CYAN, name="Live dot")
    set_title(s, 1.45, 0.7, tw + 0.3, 0.8, Rn(title, 28, TEXT, SANS, True), anchor="m")
    if caption:
        cw_ = (_run_width_in(Rn(caption, 16, TEXT)) or 0.11 * len(caption)) + 0.7
        pill(sh, 0.75, H - 0.95, cw_, 0.6, fill=BG, line=BORDER, lw=1.0, runs=[Rn(caption, 16, TEXT)],
             alpha=0.88, name=f"{title} caption")
    bring_to_front(s.shapes.title)  # above the screenshot and the chip
    done(s, notes)


def s5_trust(prs, notes):
    s = new_slide(prs)
    sh = s.shapes
    header(s, 5, "TRUST BOUNDARY", "Gemini proposes, code decides")
    top, bh = 2.0, 2.7
    # Gemini
    panel(sh, M, top, 2.5, bh, name="Gemini box")
    label(sh, M + 0.3, top + 0.28, 2.0, 0.3, "GEMINI", 14, CYAN, MONO, True, spc=2.5)
    text(sh, M + 0.3, top + 0.72, 2.0, 1.2, Pa(Rn("Designs a 3D shape program", 20, TEXT), ls=1.05))
    label(sh, M + 0.3, top + bh - 0.6, 2.0, 0.3, '{"parts": […]}', 12, MUTED, MONO)
    # trust boundary
    tbx = M + 2.5 + 0.42
    seg(sh, tbx, top - 0.12, tbx, top + bh + 0.08, color=AMBER, lw=2, dash=MSO_LINE_DASH_STYLE.DASH, cap="flat")
    label(sh, tbx - 1.2, top + bh + 0.14, 2.4, 0.3, "TRUST BOUNDARY", 11, AMBER, MONO, True, spc=2, align="c")
    # Code
    cx, cw = tbx + 0.42, 4.55
    seg(sh, M + 2.5, top + bh / 2, cx, top + bh / 2, color=CYAN, lw=2, tail=True)
    panel(sh, cx, top, cw, bh, fill=CYAN_DEEP, line=CYAN, lw=1.25, name="Code box")
    label(sh, cx + 0.3, top + 0.28, 1.0, 0.3, "CODE", 14, CYAN, MONO, True, spc=2.5)
    label(sh, cx + 1.25, top + 0.29, cw - 1.5, 0.3, "build → measure → guardrail", 13, TEXT, MONO)
    for i, (k, v) in enumerate(LIMITS):
        ry = top + 0.8 + i * 0.43
        label(sh, cx + 0.3, ry, 1.7, 0.35, k, 17, MUTED, MONO)
        label(sh, cx + 2.05, ry, cw - 2.3, 0.35, v, 17, TEXT, MONO, True)
    # outcomes
    ox, ow = cx + cw + 0.55, 2.0
    sy, ry_ = top + 0.7, top + bh - 0.7
    seg(sh, cx + cw, sy, ox, sy, color=CYAN, lw=2, tail=True)
    seg(sh, cx + cw, ry_, ox, ry_, color=AMBER, lw=2, tail=True)
    pill(sh, ox, sy - 0.32, ow, 0.64, fill=CYAN_DEEP, line=CYAN, runs=[Rn("SCALE TO FIT", 14, CYAN, MONO, True, spc=1)])
    pill(sh, ox, ry_ - 0.32, ow, 0.64, fill=AMBER_DEEP, line=AMBER, runs=[Rn("REFUSE", 14, AMBER, MONO, True, spc=1)])
    ax = ox + ow + 0.45
    seg(sh, ox + ow, sy, ax, sy, color=CYAN, lw=2, tail=True)
    panel(sh, ax, sy - 0.62, R - ax, 1.24, name="Arm box")
    arm_glyph(sh, ax + 0.18, sy - 0.5, 0.85, 0.75, lw=3.5)
    label(sh, ax + 0.18, sy + 0.3, R - ax - 0.3, 0.25, "SO-101", 11, MUTED, MONO, spc=1)
    text(sh, ox + ow + 0.22, ry_ - 0.36, R - ox - ow - 0.22, 0.72,
         Pa(Rn("and says why,\nout loud", 15, MUTED), ls=1.05), anchor="m")
    # measured examples: one scaled, one refused
    ey = 5.36
    label(sh, M, ey, 9.0, 0.3, "MEASURED IN THE APP  ·  SO-101 LIMITS", 11, CYAN, MONO, True, spc=2)
    examples = [
        [Rn("✓  ", 15, CYAN, MONO, True), Rn(SCALED["name"], 15, TEXT, MONO, True),
         Rn(f"  {SCALED['designed']}", 15, MUTED, MONO), Rn(f"  → {SCALED['verdict']}", 15, AMBER, MONO),
         Rn(f"  → {SCALED['scale']} →  ", 15, MUTED, MONO), Rn(SCALED["result"], 15, CYAN, MONO, True)],
        [Rn("✗  ", 15, AMBER, MONO, True), Rn(REFUSED["name"], 15, TEXT, MONO, True),
         Rn("  refused  ", 15, AMBER, MONO), Rn(f"“{REFUSED['reason']}”", 15, MUTED)],
    ]
    for i, runs in enumerate(examples):
        yy = ey + 0.38 + i * 0.66
        panel(sh, M, yy, W - 2 * M, 0.56, snip=0.16, name=f"Measured example {i + 1}")
        text(sh, M + 0.3, yy, W - 2 * M - 0.5, 0.56, Pa(*runs), anchor="m")
    done(s, notes)


def s6_safety(prs, notes):
    s = new_slide(prs)
    sh = s.shapes
    header(s, 6, "SAFETY PRECEDENCE", "Hand signals beat the AI")
    label(sh, M, 1.9, 8.0, 0.3, "WHO WINS, HIGHEST FIRST", 11, MUTED, MONO, spc=2)
    chain = [("HAND SIGNALS", 2.75, CYAN, BG, CYAN, None),
             ("PANEL", 1.55, CYAN_DEEP, CYAN, CYAN, None),
             ("CODE GATE", 2.15, PANEL, TEXT, MUTED, None),
             ("AI", 1.1, None, MUTED, MUTED, MSO_LINE_DASH_STYLE.DASH)]
    x, y = M, 2.3
    for i, (t, w, fill, fg, line, dash) in enumerate(chain):
        pill(sh, x, y, w, 0.66, fill=fill, line=line, lw=1.5, dash=dash, runs=[Rn(t, 16, fg, MONO, True, spc=2)])
        x += w
        if i < len(chain) - 1:
            label(sh, x, y, 0.6, 0.66, "›", 30, MUTED, MONO, True, align="c", anchor="m")
            x += 0.6
    tiles = [("STOP", "Open palm", "SPEED → 0", AMBER, PANEL, 1.5),
             ("E-STOP", "Held fist", "TELEOP OFF", AMBER, AMBER_DEEP, 2.25),
             ("RESUME", "Thumbs-up", "BACK TO RUNNING", CYAN, PANEL, 1.5),
             ("HOLD", "No hand in view", "DEAD-MAN: ARM WAITS", MUTED, PANEL, 1.25)]
    gap = 0.3
    tw = (W - 2 * M - 3 * gap) / 4
    ty, th = 3.4, 2.55
    for i, (state, gesture, effect, color, fill, lw) in enumerate(tiles):
        tx = M + i * (tw + gap)
        panel(sh, tx, ty, tw, th, fill=fill, line=color, lw=lw, name=f"{state} tile")
        circle(sh, tx + 0.42, ty + 0.45, 0.26, fill=color if state != "HOLD" else None, line=color, lw=1.5)
        label(sh, tx + 0.3, ty + 0.85, tw - 0.5, 0.55, state, 30, color, MONO, True)
        label(sh, tx + 0.3, ty + 1.5, tw - 0.5, 0.4, gesture, 20, TEXT, SANS, True)
        label(sh, tx + 0.3, ty + 2.0, tw - 0.4, 0.3, effect, 11, MUTED, MONO, spc=1)
    text(sh, M, 6.3, W - 2 * M, 0.45,
         Pa(Rn("Gemini can ", 20, TEXT), Rn("never", 20, AMBER, SANS, True),
            Rn(" start, stop, resume or reset the bay.", 20, TEXT)))
    done(s, notes)


def s7_arch(prs, notes):
    s = new_slide(prs)
    sh = s.shapes
    header(s, 7, "ARCHITECTURE", "No API key ever reaches the browser")
    top, ph = 2.0, 3.95
    # browser
    bw = 5.0
    panel(sh, M, top, bw, ph, name="Browser")
    text(sh, M + 0.3, top + 0.28, bw - 0.6, 0.3,
         Pa(Rn("BROWSER", 14, CYAN, MONO, True, spc=2.5), Rn("   YOUR LAPTOP", 11, MUTED, MONO, spc=1.5)))
    mods = ["MediaPipe hands", "three.js bay", "SO-101 IK", "Fabricator", "Teleop"]
    cw_, chh, cg = 2.05, 0.62, 0.3
    for i, m in enumerate(mods):
        mx, my = M + 0.3 + (i % 2) * (cw_ + cg), top + 0.85 + (i // 2) * (chh + 0.22)
        rect(sh, mx, my, cw_, chh, fill=BG, line=BORDER, lw=1.25, kind=MSO_SHAPE.ROUNDED_RECTANGLE, adj=0.18)
        label(sh, mx, my, cw_, chh, m, 16, TEXT, align="c", anchor="m")
    label(sh, M + 0.3, top + ph - 0.5, bw - 0.6, 0.3, "WEBCAM FRAMES STAY HERE", 11, MUTED, MONO, spc=1.5)
    # server
    sx, sw = M + bw + 0.75, 3.25
    seg(sh, M + bw + 0.06, top + ph / 2, sx - 0.06, top + ph / 2, color=CYAN, lw=2, head=True, tail=True)
    panel(sh, sx, top, sw, ph, fill=CYAN_DEEP, line=CYAN, lw=1.25, name="Vultr server")
    label(sh, sx + 0.3, top + 0.28, sw - 0.5, 0.3, "VULTR SERVER", 14, CYAN, MONO, True, spc=2.5)
    label(sh, sx + 0.3, top + 0.64, sw - 0.5, 0.3, "NODE 22 · NO DEPENDENCIES", 11, MUTED, MONO, spc=1)
    pill(sh, sx + 0.3, top + 1.1, sw - 0.6, 0.5, fill=CYAN, line=None,
         runs=[Rn("API KEYS LIVE HERE", 12, BG, MONO, True, spc=1.5)])
    for i, route in enumerate(["/api/tts", "/api/gemini/*", "/api/gemini/live-token"]):
        label(sh, sx + 0.3, top + 1.9 + i * 0.45, sw - 0.5, 0.35, route, 14, TEXT, MONO)
    # external APIs
    ex = sx + sw + 0.75
    ew, eh = R - ex, (ph - 0.25) / 2
    for i, (name, items) in enumerate([("GEMINI", ["Flash", "Robotics-ER", "Live"]),
                                       ("ELEVENLABS", ["Voice", "Sound effects"])]):
        ey = top + i * (eh + 0.25)
        seg(sh, sx + sw + 0.06, ey + eh / 2, ex - 0.06, ey + eh / 2, color=CYAN, lw=2, head=True, tail=True)
        panel(sh, ex, ey, ew, eh, name=name)
        label(sh, ex + 0.3, ey + 0.22, ew - 0.5, 0.3, name, 14, CYAN, MONO, True, spc=2.5)
        text(sh, ex + 0.3, ey + 0.62, ew - 0.5, eh - 0.7, *[Pa(Rn(t, 16, TEXT), after=2) for t in items])
    text(sh, M, 6.3, W - 2 * M, 0.45,
         Pa(Rn("Hand tracking runs on your device. ", 20, TEXT),
            Rn("Gemini Live gets a short-lived token, never the key.", 20, MUTED)))
    done(s, notes)


def s8_scope(prs, notes):
    s = new_slide(prs)
    sh = s.shapes
    header(s, 8, "HONEST SCOPE", "What's real, what's simulated")
    top, ph = 1.95, 3.92
    rw = 7.45
    panel(sh, M, top, rw, ph, name="Real")
    label(sh, M + 0.3, top + 0.28, 3.0, 0.3, "REAL", 14, CYAN, MONO, True, spc=2.5)
    real = ["Hand tracking: webcam, on-device", "Voice: Gemini Live in, ElevenLabs out",
            "Gemini and ElevenLabs API calls", "SO-101 geometry: MuJoCo Menagerie", "NASA asteroid shape models"]
    for i, t in enumerate(real):
        yy = top + 0.78 + i * 0.5
        circle(sh, M + 0.42, yy + 0.16, 0.14, fill=CYAN)
        label(sh, M + 0.68, yy, 4.75, 0.38, t, 17, TEXT)
    label(sh, M + 0.3, top + ph - 0.45, 5.0, 0.3, f"KINEMATICS CROSS-CHECKED VS MUJOCO: {ARM['fk_check']}",
          11, CYAN, MONO, spc=1)
    # the four NASA shape models, 2 x 2
    for i, n in enumerate(["bennu", "itokawa", "eros", "kleopatra"]):
        cx, cy = M + 5.95 + (i % 2) * 0.98, top + 1.25 + (i // 2) * 1.45
        asteroid(sh, n, cx, cy, 0.78, lw=1.25)
        label(sh, cx - 0.55, cy + 0.47, 1.1, 0.25, n.upper(), 10, MUTED, MONO, align="c")
    sx = M + rw + 0.35
    panel(sh, sx, top, R - sx, ph, fill=AMBER_DEEP, line=AMBER, lw=1.25, name="Simulated")
    label(sh, sx + 0.3, top + 0.28, 3.0, 0.3, "SIMULATED", 14, AMBER, MONO, True, spc=2.5)
    sim = ["Arm: kinematic, no physics", "Grasp: attaches by rule", "Mass: assumed densities"]
    for i, t in enumerate(sim):
        yy = top + 0.85 + i * 0.55
        circle(sh, sx + 0.42, yy + 0.16, 0.14, fill=None, line=AMBER, lw=1.75)
        label(sh, sx + 0.68, yy, R - sx - 0.9, 0.38, t, 17, TEXT)
    label(sh, sx + 0.3, top + ph - 0.45, R - sx - 0.5, 0.3, "DISCLOSED IN THE APP AND README", 11, AMBER, MONO,
          spc=1)
    text(sh, M, 6.1, W - 2 * M, 0.95,
         Pa(Rn("CREDITS  ", 11, CYAN, MONO, True, spc=1.5),
            Rn("SO-101 model: MuJoCo Menagerie (Apache-2.0) · Asteroids and Mars: NASA 3D Resources, Itokawa "
               "NASA/JAXA, no endorsement implied · three.js, React, MediaPipe, @google/genai", 12, MUTED),
            after=5),
         Pa(Rn("AI TOOLS  ", 11, CYAN, MONO, True, spc=1.5),
            Rn("Claude Code wrote most of the code under my direction · Gemini and ElevenLabs run in the app · "
               "all code written at UB Hacking", 12, MUTED)))
    done(s, notes)


def s9_next(prs, notes):
    s = new_slide(prs)
    sh = s.shapes
    header(s, 9, "LEARNED · NEXT", "What we learned, what's next")
    top = 1.95
    lw_ = 5.55
    panel(sh, M, top, lw_, 4.75, name="New skills")
    label(sh, M + 0.3, top + 0.28, 3.0, 0.3, "NEW SKILLS", 14, CYAN, MONO, True, spc=2.5)
    skills = ["On-device hand teleop", "AI shape programs + measured guardrails", "ElevenLabs voice design",
              "Deploying on Vultr"]
    slot = 0.93
    for i, t in enumerate(skills):
        yy = top + 0.72 + i * slot
        label(sh, M + 0.3, yy, 0.6, slot, f"{i + 1:02d}", 14, MUTED, MONO, True, anchor="m")
        text(sh, M + 0.95, yy, lw_ - 1.25, slot, Pa(Rn(t, 20, TEXT), ls=1.05), anchor="m")
    nx = M + lw_ + 0.55
    label(sh, nx, top + 0.05, 3.0, 0.3, "NEXT", 14, CYAN, MONO, True, spc=2.5)
    steps = [("Record teleop sessions as LeRobot datasets", None, dataset_glyph),
             ("Train ACT policies", "ZHAO ET AL., 2023", network_glyph),
             ("Run it on a real SO-101 arm", None, arm_glyph)]
    bh_, gap = 1.08, 0.38
    for i, (t, cite, glyph) in enumerate(steps):
        by = top + 0.5 + i * (bh_ + gap)
        panel(sh, nx, by, R - nx, bh_, fill=CYAN_DEEP if i == 2 else PANEL, line=CYAN if i == 2 else BORDER,
              lw=1.25, snip=0.2, name=f"Step {i + 1}")
        label(sh, nx + 0.3, by, 0.5, bh_, str(i + 1), 28, CYAN, MONO, True, anchor="m")
        paras = [Pa(Rn(t, 19, TEXT), ls=1.05, after=3 if cite else 0)]
        if cite:
            paras.append(Pa(Rn(cite, 11, MUTED, MONO, spc=1)))
        text(sh, nx + 0.9, by, R - nx - 2.1, bh_, *paras, anchor="m")
        gx = R - 1.0
        if glyph is arm_glyph:
            glyph(sh, gx - 0.05, by + 0.14, 0.8, 0.8, lw=3)
        elif glyph is network_glyph:
            glyph(sh, gx, by + 0.22, 0.66, 0.64)
        else:
            glyph(sh, gx, by + 0.27, 0.66, 0.6)
        if i < 2:
            seg(sh, nx + 0.55, by + bh_ + 0.06, nx + 0.55, by + bh_ + gap - 0.06, color=CYAN, lw=2, tail=True)
    done(s, notes)


def s10_thanks(prs, notes):
    s = new_slide(prs)
    sh = s.shapes
    stars(sh, 110, 11, avoid=[(0.2, 1.2, 9.0, 5.65)])
    label(sh, 0.8, 1.6, 7.0, 0.35, "STARHAND", 13, CYAN, MONO, True, spc=4)
    set_title(s, 0.8, 1.98, 8.0, 1.3, Rn("Thank you", 72, TEXT, SANS, True))
    label(sh, 0.8, 3.3, 8.0, 0.5, "Reach into deep space, safely.", 26, TEXT)
    for i, (k, v, url) in enumerate(LINKS):
        yy = 4.25 + i * 0.52
        pending = v.startswith("<")
        label(sh, 0.8, yy + 0.05, 1.1, 0.3, k, 12, CYAN, MONO, True, spc=2)
        text(sh, 1.95, yy, 6.9, 0.4, Pa(Rn(v, 17, AMBER if pending else TEXT, MONO, link=None if pending else url)))
    text(sh, 0.8, 6.1, 7.5, 0.6,
         Pa(Rn(PRESENTER, 18, TEXT, SANS, True), Rn("   UB HACKING 2026", 12, MUTED, MONO, spc=1.5)))
    bx, by, bw, bh = 9.35, 2.0, 3.3, 3.5
    asteroid(sh, "bennu", bx + bw / 2, by + bh / 2, 2.75, lw=1.75)
    brackets(sh, bx, by, bw, bh, arm=0.36)
    done(s, notes)


# ---------------------------------------------------------------------------------------------
# Theme, notes, export
# ---------------------------------------------------------------------------------------------
def apply_theme(prs) -> None:
    """Dark master + palette + fonts, so slides added later in PowerPoint match the deck."""
    master = prs.slide_master
    clr_map = master._element.find(qn("p:clrMap"))
    clr_map.set("bg1", "dk1")
    clr_map.set("tx1", "lt1")
    clr_map.set("bg2", "dk2")
    clr_map.set("tx2", "lt2")
    part = master.part.part_related_by(RT.THEME)
    root = etree.fromstring(part.blob)
    ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
    scheme = root.find(".//a:clrScheme", ns)
    scheme.set("name", "STARHAND")
    colors = {"dk1": BG, "lt1": TEXT, "dk2": PANEL, "lt2": MUTED, "accent1": CYAN, "accent2": AMBER,
              "accent3": MUTED, "accent4": BORDER, "accent5": CYAN_DEEP, "accent6": TEXT,
              "hlink": CYAN, "folHlink": MUTED}
    for tag, val in colors.items():
        el = scheme.find(f"a:{tag}", ns)
        for child in list(el):
            el.remove(child)
        etree.SubElement(el, qn("a:srgbClr")).set("val", val)
    fonts = root.find(".//a:fontScheme", ns)
    fonts.set("name", "STARHAND")
    for which in ("a:majorFont", "a:minorFont"):
        fonts.find(f"{which}/a:latin", ns).set("typeface", SANS)
    for style in root.findall(".//a:effectStyleLst/a:effectStyle", ns):  # no drop shadows anywhere
        for child in list(style):
            style.remove(child)
        etree.SubElement(style, qn("a:effectLst"))
    part._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def load_notes(path: Path) -> dict[int, str]:
    """Presenter notes: the body of each '### Slide N' section of SPEAKER-NOTES.md, as plain text."""
    notes: dict[int, list[str]] = {}
    if not path.exists():
        return {}
    cur = None
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^###\s+Slide\s+(\d+)\b(.*)$", line)
        if m:
            cur = int(m.group(1))
            notes[cur] = [m.group(2).strip(" ·—-")] if m.group(2).strip(" ·—-") else []
            continue
        if line.startswith("#"):
            cur = None
            continue
        if cur is not None:
            notes[cur].append(re.sub(r"\*\*|`", "", line).replace("> ", "", 1).rstrip())
    out = {}
    for k, lines in notes.items():
        body = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
        if body:
            out[k] = body
    return out


def export_pdf(pptx: Path) -> Path:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        sys.exit("LibreOffice (soffice) not found; install it or export the PDF from PowerPoint.")
    with tempfile.TemporaryDirectory(prefix="lo_profile_") as profile:
        # A private profile, so a running LibreOffice window cannot swallow the conversion.
        subprocess.run([soffice, f"-env:UserInstallation={Path(profile).as_uri()}", "--headless",
                        "--convert-to", "pdf", "--outdir", str(pptx.parent), str(pptx)],
                       check=True, timeout=300, capture_output=True)
    pdf = pptx.with_suffix(".pdf")
    if not pdf.exists():
        sys.exit(f"LibreOffice did not write {pdf}")
    return pdf


def build(out: Path) -> Path:
    prs = Presentation()
    prs.slide_width, prs.slide_height = E(W), E(H)
    apply_theme(prs)
    cp = prs.core_properties
    cp.title = "STARHAND — reach into a deep-space sample bay with your bare hand"
    cp.author = PRESENTER
    cp.subject = "UB Hacking 2026 pitch deck"
    cp.keywords = "STARHAND; UB Hacking 2026; SO-101; Gemini; ElevenLabs; MediaPipe"
    notes = load_notes(NOTES_MD)
    s1_title(prs, notes)
    s2_problem(prs, notes)
    s3_what(prs, notes)
    screenshot_slide(prs, notes, "bay")          # 4: the live demo starts here
    for make in (s5_trust, s6_safety, s7_arch, s8_scope, s9_next, s10_thanks):
        make(prs, notes)
    screenshot_slide(prs, notes, "teleop")       # 11, 12: backup for a failed demo and for questions
    screenshot_slide(prs, notes, "fabricator")
    assert len(prs.slides) == TOTAL + 2, f"expected {TOTAL + 2} slides, built {len(prs.slides)}"
    out.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=OUT, help="output .pptx (default: slides/STARHAND.pptx)")
    ap.add_argument("--pdf", action="store_true", help="also export a PDF next to the .pptx with LibreOffice")
    args = ap.parse_args()
    out = build(args.out)
    print(f"wrote {out}")
    for stem in SCREENSHOTS:
        found = find_shot(stem)
        print(f"  screenshots/{stem}: {found.name if found else 'missing, placeholder drawn'}")
    for w in FIT_WARNINGS:
        print("  fit warning:", w)
    if args.pdf:
        print(f"wrote {export_pdf(out)}")


if __name__ == "__main__":
    main()
