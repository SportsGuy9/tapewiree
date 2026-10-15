"""QR code for the hosted demo: black on white, with a caption, sized for a phone screen."""
import sys
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFont

URL = sys.argv[1] if len(sys.argv) > 1 else "https://claude.ai/artifact/XbMuZUpbRqGXdmkfUGZkU4"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / "demo" / "scangap-demo-qr.png")

qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=24, border=4)
qr.add_data(URL)
qr.make(fit=True)
code = qr.make_image(fill_color="black", back_color="white").convert("RGB")

W = 1080  # phone-width canvas
code = code.resize((W - 80, W - 80), Image.NEAREST)
canvas = Image.new("RGB", (W, W + 200), "white")
canvas.paste(code, (40, 40))
draw = ImageDraw.Draw(canvas)
font = None
for f in ("DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "Arial Bold.ttf", "arialbd.ttf"):
    try:
        font = ImageFont.truetype(f, 88)
        break
    except OSError:
        continue
font = font or ImageFont.load_default()
text = "ScanGap demo"
w = draw.textlength(text, font=font)
draw.text(((W - w) / 2, W + 30), text, fill="black", font=font)
OUT.parent.mkdir(parents=True, exist_ok=True)
canvas.save(OUT)
print(f"wrote {OUT} ({canvas.size[0]}x{canvas.size[1]}) for {URL}")
