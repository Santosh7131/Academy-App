"""Makes the website's pictures from the app's screen pictures, and copies the app's fonts and icon to it.

    python tools/website-pictures.py           # everything
    python tools/website-pictures.py --desk    # only the pictures of the app on a computer

Needs Python with Pillow. Draw the screens first (in app/: SHOTS=1 flutter test test/shots/screens_test.dart);
they land in tools/out/shots. Each website picture is the same screen in light and in dark. A phone's is cut to
1080 x 2400 from the top and scaled to 540 wide; a computer's (the "desk: the app on a computer" scene, 1440 x 900
drawn at twice the size) is scaled to 2400 wide. The page shows the dark one when the visitor's phone or computer is dark.
"""
import shutil
import sys
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parent.parent
shots = root / "tools" / "out" / "shots"
site = root / "website"
img = site / "img"
img.mkdir(parents=True, exist_ok=True)
(site / "fonts").mkdir(exist_ok=True)

# website picture -> app screen picture
PICK = {
    "tutor-home": "home-full",
    "paper-check": "paper-check",
    "student-test": "test-taking",
    "student-page": "tutor-student",
}
W, H = 1080, 2400

# website picture -> the app on a computer
DESK = {
    "desk-home": "desk-home",
    "desk-group": "desk-group",
}
for out, src in DESK.items():
    for theme in ("light", "dark"):
        p = shots / f"{src}-{theme}.png"
        im = Image.open(p).convert("RGB")
        if (im.width, im.height) != (2880, 1800):
            raise SystemExit(f"{p.name} is {im.width} x {im.height}; expected 2880 x 1800")
        im.resize((2400, 1500), Image.LANCZOS).save(img / f"{out}-{theme}.png", optimize=True)
        print(f"img/{out}-{theme}.png")
if "--desk" in sys.argv:
    raise SystemExit(0)

for out, src in PICK.items():
    for theme in ("light", "dark"):
        p = shots / f"{src}-{theme}.png"
        im = Image.open(p).convert("RGB")
        if im.width != W or im.height < H:
            raise SystemExit(f"{p.name} is {im.width} x {im.height}; expected {W} wide and at least {H} high")
        im.crop((0, 0, W, H)).resize((540, 1200), Image.LANCZOS).save(img / f"{out}-{theme}.png", optimize=True)
        print(f"img/{out}-{theme}.png")

icon = Image.open(root / "app/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png").convert("RGBA")
icon.resize((192, 192), Image.LANCZOS).save(img / "icon-192.png", optimize=True)
icon.resize((32, 32), Image.LANCZOS).save(img / "icon-32.png", optimize=True)

for f in ("Geist.ttf", "GeistMono.ttf", "OFL.txt"):
    shutil.copy2(root / "app/assets/fonts" / f, site / "fonts" / f)
print("icon and fonts copied")
