"""Bake the S22 evidence bands at the exact aspect the band renders at.

Why: the S22 image band is 100vw x 56vh. On a 16:9 viewport that is ~3.175:1,
not 21:9. Baking at 21:9 forces object-fit:cover to crop ~27% off the height,
which sliced a row off the issue list. Baking at the band's own aspect means
cover crops nothing, so every row stays visible and the evidence stays legible.

Rules kept from screenshots-framing.md (Style B): square corners, no shadow, no
rounded corners, paper page, crop on natural boundaries.
"""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "ppt", "images")
PAPER = (250, 250, 248)

BW, BH = 3175, 1000          # == 100vw x 56vh on a 16:9 viewport (~3.175:1)
BAND_RATIO = BW / BH


def crop_band(src, box):
    """Crop `box` (already at ~band ratio) and resize to the band canvas."""
    shot = src.crop(box)
    assert abs(shot.width / shot.height - BAND_RATIO) < 0.02, \
        f"crop {box} ratio {shot.width/shot.height:.3f} != {BAND_RATIO:.3f}"
    return shot.resize((BW, BH), Image.LANCZOS)


# --- page 06: issue list, ends on the row separator at y=815 -------------
src = Image.open(os.path.join(ROOT, "docs/screenshots/yunxiao-launch-mode/01-issue-list-entries.png")).convert("RGB")
crop_band(src, (0, 175, 1920, 780)).save(os.path.join(OUT, "06-yunxiao-entries-21x9.png"), "PNG", optimize=True)

# --- page 09: code diff (drop the far-right file tree, keep the diff) ----
src = Image.open(os.path.join(ROOT, "docs/screenshots/diff-review-comments/D3-dark-drawer.png")).convert("RGB")
crop_band(src, (130, 140, 1830, 675)).save(os.path.join(OUT, "09-review-comments-21x9.png"), "PNG", optimize=True)

# --- page 13: dependency graph, right-anchored on a quiet paper field ----
src = Image.open(os.path.join(ROOT, "docs/pr-screenshots/plan-board-v2-dark.png")).convert("RGB").crop((0, 26, 1600, 530))
canvas = Image.new("RGB", (BW, BH), PAPER)
scale = 1.23
graph = src.resize((round(src.width * scale), round(src.height * scale)), Image.LANCZOS)
gx = BW - graph.width
gy = (BH - graph.height) // 2
canvas.paste(graph, (gx, gy))
canvas.save(os.path.join(OUT, "13-dep-chain-21x9.png"), "PNG", optimize=True)

for name in ("06-yunxiao-entries-21x9.png", "09-review-comments-21x9.png", "13-dep-chain-21x9.png"):
    p = os.path.join(OUT, name)
    im = Image.open(p)
    print(f"{name}  {im.size[0]}x{im.size[1]}  ratio={im.size[0]/im.size[1]:.3f}  {os.path.getsize(p)//1024}KB")
