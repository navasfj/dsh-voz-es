#!/usr/bin/env python3
"""Genera las imágenes del repositorio en español e inglés.

Uso:  python scripts/make-assets.py
Salida:
  assets/banner.png, assets/architecture.png, assets/mute-estados.png          (español)
  assets/banner.en.png, assets/architecture.en.png, assets/mute-states.en.png  (inglés)
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FONTS = Path("C:/Windows/Fonts")

BG_TOP = (10, 16, 32)
BG_BOTTOM = (16, 27, 54)
CARD = (15, 24, 48)
BORDER = (36, 48, 79)
WHITE = (248, 250, 252)
MUTED = (165, 180, 206)
BLUE = (59, 130, 246)
LIGHT_BLUE = (147, 197, 253)
GREEN = (34, 197, 94)
INDIGO = (129, 140, 248)
AMBER = (245, 158, 11)

COPY = {
    "es": {
        "banner": {
            "subtitle": ["Dictado y lectura en voz alta", "100 % local · en español"],
            "card": "Conversación",
            "tooltip": "Dictar",
            "controls": "micrófono · dictado       altavoz · lectura",
            "footer": "Instalable desde GitHub, índice de plugins o npm",
        },
        "architecture": {
            "title": "Arquitectura",
            "subtitle": "Todo ocurre en el equipo: el audio y el texto no salen a ningún servicio",
            "browser": ("Navegador (DSH Web)", ["Micrófono + waveform", "Sube WAV a 16 kHz", "Reproduce el WAV", "Inserta el texto"]),
            "host": ("Host DSH", ["Rutas autenticadas", "Cola y procesos hijos", "Sin bloquear la interfaz"]),
            "child": ("Procesos hijos", ["Whisper (ASR)", "Piper (TTS)"]),
            "disk": ("Modelos en disco", ["~/.dsh/…/whisper-small", "~/.dsh/…/piper-es", "Verificados por SHA-256"]),
            "arrows": ["audio WAV", "texto / WAV", "HTTP + token", "resultado", "lee"],
            "no_network": "Sin red en tiempo de uso",
            "no_network_detail": "Los modelos se descargan una vez y se verifican; después todo es local.",
            "private": "Privado",
            "private_detail": "Sin telemetría, sin cuentas, sin servicios de voz.",
        },
        "mute": {
            "title": "El mute, paso a paso",
            "subtitle": "Silenciar pausa el relato; nunca lo reinicia desde el principio.",
            "reading": ("Leyendo", ["altavoz verde con ondas"]),
            "muted": ("Silenciado", ["altavoz rojo tachado", "el relato queda en pausa"]),
            "discarded": ("Descartado", ["rojo, sin relato pendiente"]),
            "click": "clic",
            "five": "5 s",
            "resume": "clic en menos de 5 s · continúa donde iba",
            "next": "una respuesta nueva vuelve a empezar",
            "footer": "Mientras está silenciado no se pierde audio: el WAV ya está descargado y se reanuda en el mismo punto.",
        },
    },
    "en": {
        "banner": {
            "subtitle": ["Dictation and read-aloud", "100% local · Spanish"],
            "card": "Conversation",
            "tooltip": "Dictate",
            "controls": "microphone · dictation       speaker · read-aloud",
            "footer": "Install from GitHub, the plugin index or npm",
        },
        "architecture": {
            "title": "Architecture",
            "subtitle": "Everything happens on your machine: audio and text never leave it",
            "browser": ("Browser (DSH Web)", ["Microphone + waveform", "Uploads 16 kHz WAV", "Plays the WAV", "Inserts the text"]),
            "host": ("DSH Host", ["Authenticated routes", "Queue and child processes", "No UI blocking"]),
            "child": ("Child processes", ["Whisper (ASR)", "Piper (TTS)"]),
            "disk": ("Models on disk", ["~/.dsh/…/whisper-small", "~/.dsh/…/piper-es", "Verified by SHA-256"]),
            "arrows": ["audio WAV", "text / WAV", "HTTP + token", "result", "reads"],
            "no_network": "No network at runtime",
            "no_network_detail": "Models are downloaded once and verified; after that everything is local.",
            "private": "Private",
            "private_detail": "No telemetry, no accounts, no voice services.",
        },
        "mute": {
            "title": "Mute, step by step",
            "subtitle": "Muting pauses the narration; it never restarts it from the beginning.",
            "reading": ("Reading", ["green speaker with waves"]),
            "muted": ("Muted", ["red slashed speaker", "the narration is paused"]),
            "discarded": ("Discarded", ["red, no pending narration"]),
            "click": "click",
            "five": "5 s",
            "resume": "click within 5 s · continues where it stopped",
            "next": "a new reply starts over",
            "footer": "Muting loses no audio: the WAV is already downloaded and resumes at the same point.",
        },
    },
}


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    height = size[1]
    for y in range(height):
        ratio = y / max(1, height - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (size[0], y)], fill=color)
    return image


def rounded(draw: ImageDraw.ImageDraw, box, radius: int, fill=None, outline=None, width: int = 1) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def glow(image: Image.Image, center: tuple[int, int], radius: int, color: tuple[int, int, int], alpha: int) -> None:
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse(
        [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius],
        fill=(*color, alpha),
    )
    layer = layer.filter(ImageFilter.GaussianBlur(radius // 2))
    image.alpha_composite(layer) if image.mode == "RGBA" else image.paste(Image.alpha_composite(image.convert("RGBA"), layer).convert("RGB"))


def grid(image: Image.Image, step: int = 40, alpha: int = 14) -> None:
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for x in range(0, image.width, step):
        draw.line([(x, 0), (x, image.height)], fill=(148, 163, 184, alpha))
    for y in range(0, image.height, step):
        draw.line([(0, y), (image.width, y)], fill=(148, 163, 184, alpha))
    image.alpha_composite(layer)


def mic_glyph(draw: ImageDraw.ImageDraw, cx: int, cy: int, scale: float, color) -> None:
    """Contorno de micrófono, estilo del icono del plugin."""
    body_w, body_h = 12 * scale, 22 * scale
    draw.rounded_rectangle(
        [cx - body_w / 2, cy - 16 * scale, cx + body_w / 2, cy - 16 * scale + body_h],
        radius=body_w / 2, outline=color, width=max(2, round(2 * scale)),
    )
    draw.arc(
        [cx - 12 * scale, cy - 14 * scale, cx + 12 * scale, cy + 8 * scale],
        start=0, end=180, fill=color, width=max(2, round(2 * scale)),
    )
    draw.line([(cx, cy + 8 * scale), (cx, cy + 15 * scale)], fill=color, width=max(2, round(2 * scale)))
    draw.line([(cx - 6 * scale, cy + 15 * scale), (cx + 6 * scale, cy + 15 * scale)], fill=color, width=max(2, round(2 * scale)))


def speaker_glyph(draw: ImageDraw.ImageDraw, cx: int, cy: int, scale: float, color) -> None:
    body = [
        (cx - 12 * scale, cy - 5 * scale), (cx - 5 * scale, cy - 5 * scale),
        (cx + 3 * scale, cy - 13 * scale), (cx + 3 * scale, cy + 13 * scale),
        (cx - 5 * scale, cy + 5 * scale), (cx - 12 * scale, cy + 5 * scale),
    ]
    draw.polygon(body, fill=color)
    width = max(2, round(2 * scale))
    draw.arc([cx + 1 * scale, cy - 8 * scale, cx + 13 * scale, cy + 8 * scale], start=-55, end=55, fill=color, width=width)
    draw.arc([cx + 5 * scale, cy - 13 * scale, cx + 21 * scale, cy + 13 * scale], start=-50, end=50, fill=color, width=width)


def banner(t: dict, out: str) -> None:
    image = vertical_gradient((1280, 640), BG_TOP, BG_BOTTOM).convert("RGBA")
    grid(image)
    glow(image, (1010, 320), 300, BLUE, 54)
    glow(image, (1120, 420), 180, GREEN, 30)
    draw = ImageDraw.Draw(image)

    rounded(draw, [72, 56, 360, 100], 22, fill=(18, 32, 64), outline=(45, 70, 120))
    draw.text((94, 66), "DEEPSEEK HARNESS PLUGIN", font=font("segoeuib.ttf", 17), fill=LIGHT_BLUE)

    draw.text((72, 128), "dsh-voz-es", font=font("segoeuib.ttf", 92), fill=WHITE)
    draw.text((76, 250), t["subtitle"][0], font=font("segoeui.ttf", 36), fill=(199, 210, 254))
    draw.text((76, 296), t["subtitle"][1], font=font("segoeui.ttf", 36), fill=(199, 210, 254))

    chips = ["Whisper small", "Piper", "MIT", "DSH 0.2.2+"]
    x = 76
    for label in chips:
        width = draw.textlength(label, font=font("segoeuib.ttf", 18)) + 34
        rounded(draw, [x, 400, x + width, 440], 20, fill=(20, 33, 60), outline=(44, 62, 98))
        draw.text((x + 17, 408), label, font=font("segoeuib.ttf", 18), fill=(203, 213, 225))
        x += width + 12

    card = [720, 120, 1208, 490]
    rounded(draw, card, 30, fill=CARD, outline=BORDER, width=2)
    draw.text((758, 158), t["card"], font=font("segoeuib.ttf", 18), fill=(100, 116, 139))
    rounded(draw, [758, 196, 1040, 212], 8, fill=(37, 51, 82))
    rounded(draw, [758, 226, 980, 242], 8, fill=(30, 42, 70))
    rounded(draw, [758, 290, 1170, 452], 22, fill=(18, 28, 54), outline=(40, 56, 92), width=2)

    heights = [10, 18, 30, 22, 40, 28, 46, 34, 20, 36, 26, 44, 30, 18, 12]
    for index, height in enumerate(heights):
        bx = 786 + index * 13
        color = BLUE if index < 8 else GREEN
        draw.rounded_rectangle([bx, 371 - height / 2, bx + 6, 371 + height / 2], radius=3, fill=color)

    draw.ellipse([966, 341, 1030, 405], fill=(37, 99, 235))
    mic_glyph(draw, 998, 371, 0.9, WHITE)
    speaker_glyph(draw, 1078, 371, 1.0, GREEN)

    tooltip_text = draw.textlength(t["tooltip"], font=font("segoeuib.ttf", 17))
    tooltip_width = tooltip_text + 22
    tooltip_left = 998 - tooltip_width / 2
    rounded(draw, [tooltip_left, 296, tooltip_left + tooltip_width, 334], 10, fill=(43, 47, 54))
    draw.text((998 - tooltip_text / 2, 305), t["tooltip"], font=font("segoeuib.ttf", 17), fill=(238, 242, 247))
    draw.polygon([(990, 334), (1006, 334), (998, 341)], fill=(43, 47, 54))

    draw.text((758, 410), t["controls"], font=font("segoeui.ttf", 15), fill=(120, 136, 166))
    draw.text((76, 560), t["footer"], font=font("segoeui.ttf", 20), fill=(120, 136, 166))

    ASSETS.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(ASSETS / out, optimize=True)


def box(draw: ImageDraw.ImageDraw, rect, title: str, lines: list[str], accent, wide: bool = False) -> None:
    rounded(draw, rect, 22, fill=(14, 23, 44), outline=(38, 52, 84), width=2)
    x0, y0, x1, _ = rect
    rounded(draw, [x0, y0, x1, y0 + 8], 4, fill=accent)
    draw.text((x0 + 24, y0 + 30), title, font=font("segoeuib.ttf", 26 if not wide else 24), fill=WHITE)
    y = y0 + 86
    for line in lines:
        draw.ellipse([x0 + 26, y + 7, x0 + 34, y + 15], fill=accent)
        draw.text((x0 + 46, y), line, font=font("segoeui.ttf", 19), fill=MUTED)
        y += 38


def arrow(draw: ImageDraw.ImageDraw, start, end, color, label: str | None = None, above: bool = True) -> None:
    draw.line([start, end], fill=color, width=3)
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    length = 14
    for side in (-0.5, 0.5):
        draw.line(
            [end, (end[0] - length * math.cos(angle + side), end[1] - length * math.sin(angle + side))],
            fill=color, width=3,
        )
    if label:
        mid = ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2 - (22 if above else -22))
        text = font("segoeui.ttf", 15)
        width = draw.textlength(label, font=text)
        draw.text((mid[0] - width / 2, mid[1]), label, font=text, fill=(148, 163, 184))


def architecture(t: dict, out: str) -> None:
    image = vertical_gradient((1600, 900), BG_TOP, BG_BOTTOM).convert("RGBA")
    grid(image)
    draw = ImageDraw.Draw(image)
    draw.text((80, 56), t["title"], font=font("segoeuib.ttf", 54), fill=WHITE)
    draw.text((84, 126), t["subtitle"], font=font("segoeui.ttf", 24), fill=MUTED)

    box(draw, [60, 220, 360, 560], *t["browser"], BLUE)
    box(draw, [460, 220, 760, 560], *t["host"], INDIGO)
    box(draw, [860, 220, 1160, 560], *t["child"], GREEN)
    box(draw, [1260, 220, 1560, 560], *t["disk"], AMBER)

    labels = t["arrows"]
    arrow(draw, (364, 330), (456, 330), LIGHT_BLUE, labels[0])
    arrow(draw, (456, 440), (364, 440), (99, 102, 241), labels[1])
    arrow(draw, (764, 330), (856, 330), INDIGO, labels[2])
    arrow(draw, (856, 440), (764, 440), INDIGO, labels[3])
    arrow(draw, (1164, 390), (1256, 390), AMBER, labels[4])

    rounded(draw, [200, 660, 1400, 760], 26, fill=(13, 22, 42), outline=(38, 52, 84), width=2)
    draw.text((248, 686), t["no_network"], font=font("segoeuib.ttf", 22), fill=GREEN)
    draw.text((248, 720), t["no_network_detail"], font=font("segoeui.ttf", 19), fill=MUTED)
    draw.text((980, 686), t["private"], font=font("segoeuib.ttf", 22), fill=LIGHT_BLUE)
    draw.text((980, 720), t["private_detail"], font=font("segoeui.ttf", 19), fill=MUTED)

    ASSETS.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(ASSETS / out, optimize=True)


def path_arrow(draw: ImageDraw.ImageDraw, points, color, dashed: bool = False, width: int = 3) -> None:
    """Dibuja una polilínea con punta de flecha; opcionalmente discontinua."""
    for index in range(len(points) - 1):
        start, end = points[index], points[index + 1]
        if not dashed:
            draw.line([start, end], fill=color, width=width)
            continue
        total = math.dist(start, end)
        if total == 0:
            continue
        dx, dy = (end[0] - start[0]) / total, (end[1] - start[1]) / total
        position = 0.0
        while position < total:
            stop = min(total, position + 10)
            draw.line(
                [(start[0] + dx * position, start[1] + dy * position),
                 (start[0] + dx * stop, start[1] + dy * stop)],
                fill=color, width=width,
            )
            position += 18
    last, previous = points[-1], points[-2]
    angle = math.atan2(last[1] - previous[1], last[0] - previous[0])
    for side in (-0.5, 0.5):
        draw.line(
            [last, (last[0] - 14 * math.cos(angle + side), last[1] - 14 * math.sin(angle + side))],
            fill=color, width=width,
        )


def state_box(draw: ImageDraw.ImageDraw, rect, title: str, lines: list[str], accent) -> None:
    rounded(draw, rect, 20, fill=(14, 23, 44), outline=(38, 52, 84), width=2)
    x0, y0, x1, _ = rect
    rounded(draw, [x0, y0, x1, y0 + 7], 3, fill=accent)
    draw.text((x0 + 22, y0 + 26), title, font=font("segoeuib.ttf", 26), fill=WHITE)
    y = y0 + 72
    for line in lines:
        draw.text((x0 + 22, y), line, font=font("segoeui.ttf", 18), fill=MUTED)
        y += 28


def mute_states(t: dict, out: str) -> None:
    image = vertical_gradient((1400, 560), BG_TOP, BG_BOTTOM).convert("RGBA")
    grid(image)
    draw = ImageDraw.Draw(image)
    draw.text((60, 42), t["title"], font=font("segoeuib.ttf", 46), fill=WHITE)
    draw.text((64, 108), t["subtitle"], font=font("segoeui.ttf", 22), fill=MUTED)

    state_box(draw, [60, 210, 380, 340], *t["reading"], GREEN)
    state_box(draw, [540, 210, 860, 340], *t["muted"], AMBER)
    state_box(draw, [1020, 210, 1340, 340], *t["discarded"], (100, 116, 139))

    arrow(draw, (384, 275), (536, 275), LIGHT_BLUE, t["click"])
    arrow(draw, (864, 275), (1016, 275), (148, 163, 184), t["five"])

    path_arrow(draw, [(700, 206), (700, 176), (220, 176), (220, 206)], GREEN)
    width = draw.textlength(t["resume"], font=font("segoeuib.ttf", 17))
    draw.text((460 - width / 2, 146), t["resume"], font=font("segoeuib.ttf", 17), fill=GREEN)

    path_arrow(draw, [(1180, 344), (1180, 452), (220, 452), (220, 344)], (100, 116, 139), dashed=True)
    width = draw.textlength(t["next"], font=font("segoeui.ttf", 17))
    draw.text((700 - width / 2, 462), t["next"], font=font("segoeui.ttf", 17), fill=(148, 163, 184))

    draw.text((60, 512), t["footer"], font=font("segoeui.ttf", 18), fill=(120, 136, 166))

    ASSETS.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(ASSETS / out, optimize=True)


def main() -> None:
    banner(COPY["es"]["banner"], "banner.png")
    architecture(COPY["es"]["architecture"], "architecture.png")
    mute_states(COPY["es"]["mute"], "mute-estados.png")
    banner(COPY["en"]["banner"], "banner.en.png")
    architecture(COPY["en"]["architecture"], "architecture.en.png")
    mute_states(COPY["en"]["mute"], "mute-states.en.png")
    print("imágenes en español e inglés generadas en assets/")


if __name__ == "__main__":
    main()
