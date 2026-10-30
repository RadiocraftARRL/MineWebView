"""Paints the demo's textures and writes its models and blockstates: a grass block and dirt (our own pixels, not
Mojang's, so the repository has no game assets in it) and a small signpost that tests element rotation and the
blockstate's y rotation. CC0, like everything under demo/assets.

    pip install pillow
    python tools/demo_assets.py
"""
import json
import random
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "demo" / "assets" / "minewebview"
rng = random.Random(7)


def noisy(base, spread, size=16):
    img = Image.new("RGBA", (size, size))
    for y in range(size):
        for x in range(size):
            k = 1.0 + rng.uniform(-spread, spread)
            img.putpixel((x, y), tuple(max(0, min(255, int(c * k))) for c in base) + (255,))
    return img


def save(img, name):
    path = ROOT / "textures" / "block" / f"{name}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


def dump(obj, rel):
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n")


dirt = noisy((134, 96, 67), 0.18)
save(dirt, "dirt")
grass_top = noisy((110, 168, 68), 0.15)
save(grass_top, "grass_top")
side = dirt.copy()
for x in range(16):  # A ragged fringe of grass over the dirt.
    for y in range(3 + rng.randint(0, 2)):
        side.putpixel((x, y), grass_top.getpixel((x, y)))
save(side, "grass_side")
wood = noisy((150, 112, 66), 0.1)
for y in range(16):
    for x in range(0, 16, 4):
        r, g, b, a = wood.getpixel((x, y))
        wood.putpixel((x, y), (int(r * 0.8), int(g * 0.8), int(b * 0.8), a))
save(wood, "wood")
arrow = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
for y in range(4, 12):
    for x in range(0, 16):
        arrow.putpixel((x, y), (230, 220, 190, 255))
for x in range(10, 16):  # The arrow head points east in the texture.
    for y in range(4, 12):
        if abs(y - 7.5) > (16 - x) * 0.8:
            arrow.putpixel((x, y), (0, 0, 0, 0))
for x in range(1, 10):
    arrow.putpixel((x, 7), (60, 60, 60, 255))
    arrow.putpixel((x, 8), (60, 60, 60, 255))
save(arrow, "sign")

dump({"parent": "minecraft:block/cube_bottom_top",
      "textures": {"top": "minewebview:block/grass_top", "bottom": "minewebview:block/dirt", "side": "minewebview:block/grass_side"}},
     "models/block/grass_block.json")
dump({"parent": "minecraft:block/cube_all", "textures": {"all": "minewebview:block/dirt"}}, "models/block/dirt.json")
dump({"variants": {"": {"model": "minewebview:block/grass_block"}}}, "blockstates/grass_block.json")
dump({"variants": {"": {"model": "minewebview:block/dirt"}}}, "blockstates/dirt.json")

# A post with a sign arm pointing north (the model's front), tilted 22.5 degrees to test element rotation.
dump({
    "textures": {"post": "minewebview:block/wood", "sign": "minewebview:block/sign", "particle": "minewebview:block/wood"},
    "elements": [
        {"from": [7, 0, 7], "to": [9, 14, 9], "faces": {f: {"texture": "#post"} for f in ["north", "south", "east", "west", "up", "down"]}},
        {"from": [7.5, 10, 0], "to": [8.5, 13, 9], "rotation": {"origin": [8, 11.5, 8], "axis": "x", "angle": 22.5},
         "faces": {"east": {"uv": [16, 4, 0, 12], "texture": "#sign"}, "west": {"uv": [0, 4, 16, 12], "texture": "#sign"},
                   "north": {"uv": [0, 4, 1, 12], "texture": "#sign"}, "up": {"uv": [0, 4, 1, 12], "texture": "#post"},
                   "down": {"uv": [0, 4, 1, 12], "texture": "#post"}}},
    ]}, "models/block/signpost.json")
dump({"variants": {f"facing={f}": {"model": "minewebview:block/signpost", **({"y": y} if y else {})}
                   for f, y in [("north", 0), ("east", 90), ("south", 180), ("west", 270)]}},
     "blockstates/signpost.json")
print("demo assets written to", ROOT)
