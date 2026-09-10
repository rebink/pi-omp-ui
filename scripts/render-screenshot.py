from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "screenshot.png"
OUT.parent.mkdir(parents=True, exist_ok=True)

W, H = 1600, 1040
BG = "#090c10"
WINDOW = "#151820"
PANEL = "#0f1216"
BORDER = "#2a3038"
BORDER_MUTED = "#1f252d"
TEXT = "#e8ecf4"
MUTED = "#9ca3b0"
DIM = "#6b7280"
BLUE = "#00b4ff"
GREEN = "#00ff88"
GOLD = "#d4c090"
AMBER = "#ffb347"
RED = "#ff4757"

FONT_PATH = "/System/Library/Fonts/Menlo.ttc"
font = ImageFont.truetype(FONT_PATH, 20)
small = ImageFont.truetype(FONT_PATH, 17)
large = ImageFont.truetype(FONT_PATH, 22)

image = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((38, 34, W - 38, H - 34), radius=22, fill=WINDOW, outline=BORDER, width=2)
draw.rounded_rectangle((38, 34, W - 38, 96), radius=22, fill=PANEL)
draw.rectangle((38, 73, W - 38, 96), fill=PANEL)
for x, color in ((72, RED), (102, AMBER), (132, GREEN)):
    draw.ellipse((x, 57, x + 15, 72), fill=color)
draw.text((690, 54), "PI  /  NORMAL ENGINE  ·  OMP PRESENTATION", font=small, fill=MUTED)


def text(x, y, value, color=TEXT, face=font):
    draw.text((x, y), value, font=face, fill=color)


def card(box, title, state_color, command, output, warning=None):
    x1, y1, x2, y2 = box
    draw.rounded_rectangle(box, radius=12, fill=PANEL, outline=state_color, width=2)
    label = f" {title} "
    label_box = draw.textbbox((0, 0), label, font=small)
    draw.rectangle((x1 + 38, y1 - 3, x1 + 38 + label_box[2], y1 + 18), fill=PANEL)
    text(x1 + 42, y1 - 8, label, state_color, small)
    text(x1 + 25, y1 + 35, "$", BLUE, large)
    text(x1 + 52, y1 + 35, command, TEXT, large)
    divider_y = y1 + 84
    draw.line((x1, divider_y, x2, divider_y), fill=state_color, width=1)
    draw.rectangle((x1 + 38, divider_y - 11, x1 + 136, divider_y + 11), fill=PANEL)
    text(x1 + 48, divider_y - 13, "output", TEXT, small)
    for index, line in enumerate(output):
        text(x1 + 25, divider_y + 24 + index * 28, line, MUTED, small)
    if warning:
        text(x1 + 25, y2 - 36, warning, AMBER, small)


# User and assistant transcript
user_box = (78, 118, W - 78, 196)
draw.rounded_rectangle(user_box, radius=8, fill=PANEL)
text(102, 141, "Give me the repository status, then run the checks.", TEXT, large)
text(82, 224, "I’ll inspect the workspace and keep the output compact.", TEXT, large)

card(
    (78, 275, W - 78, 510),
    "✔ done  ·  bash",
    DIM,
    "git status --short && npm test",
    [
        "On branch main · working tree clean",
        "✓ 24 tests passed",
        "Took 1.1s",
    ],
)

# Task tree
text(80, 553, "TASKS", BLUE, small)
text(82, 592, "├─ ✔ Inspect repository", GREEN, small)
text(82, 626, "├─ ⟳ Validate changes", BLUE, small)
text(82, 660, "│  ├─ ✔ Typecheck", GREEN, small)
text(82, 694, "│  └─ ○ Package smoke test", MUTED, small)
text(82, 728, "└─ ○ Publish release", DIM, small)

# Edit card
edit_box = (670, 550, W - 78, 755)
draw.rounded_rectangle(edit_box, radius=12, fill=PANEL, outline=DIM, width=2)
draw.rectangle((708, 547, 910, 571), fill=PANEL)
text(714, 543, " ✔ done  ·  edit ", GREEN, small)
text(697, 590, "edit", TEXT, small)
text(762, 590, "extensions/omp-ui.ts", BLUE, small)
draw.line((670, 630, W - 78, 630), fill=DIM, width=1)
text(697, 650, "- native Pi shell", RED, small)
text(697, 684, "+ OMP frame · native Pi execution", GREEN, small)
text(697, 718, "Tool schema and result remain unchanged", MUTED, small)

# Composer band
composer_top = 805
text(78, composer_top - 15, "──", BLUE, large)
text(125, composer_top - 15, "⠹ Working", BLUE, small)
draw.line((235, composer_top, W - 78, composer_top), fill=BLUE, width=2)
text(102, composer_top + 30, "Ask Pi…", DIM, large)
draw.line((78, composer_top + 78, W - 78, composer_top + 78), fill=BORDER_MUTED, width=2)

# Footer
text(80, 914, "~/workspace/omp_ui_ux_for_pi", DIM, small)
text(430, 914, "main", GREEN, small)
text(80, 950, "↑18.4k  ↓2.1k  R14.9k  $0.042", DIM, small)
text(510, 950, "·  38.7%/272k", MUTED, small)
text(1250, 950, "sol", BLUE, small)
text(1310, 950, "· high", GOLD, small)

image.save(OUT, optimize=True)
print(OUT)
