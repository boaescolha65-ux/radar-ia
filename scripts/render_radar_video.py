#!/usr/bin/env python3
"""Renderiza vídeos do O Seu Radar com movimento, transições e identidade visual."""
import argparse
import json
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def run(command):
    subprocess.run(command, check=True)


def probe_duration(audio_path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "json", str(audio_path)],
        check=True, capture_output=True, text=True,
    )
    duration = float(json.loads(result.stdout)["format"]["duration"])
    if duration <= 0:
        raise ValueError("Não foi possível identificar a duração do áudio.")
    return duration


def make_short_overlay(path, headline, edition_date):
    """Tarjas e manchete são desenhadas em alta resolução com quebra automática."""
    canvas = Image.new("RGBA", (1080, 1920), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    cyan = (28, 210, 224, 255)
    white = (250, 252, 255, 255)
    muted = (190, 213, 224, 255)
    bold = ImageFont.truetype(FONT_BOLD, 36)
    regular = ImageFont.truetype(FONT_REGULAR, 25)

    # Identificação superior discreta, com contraste constante sobre qualquer imagem.
    draw.rounded_rectangle((48, 54, 520, 178), radius=26,
                           fill=(5, 22, 38, 218), outline=(28, 210, 224, 190), width=3)
    draw.text((78, 72), "O SEU RADAR", font=bold, fill=cyan)
    draw.text((80, 126), "TECNOLOGIA  •  INTELIGÊNCIA ARTIFICIAL",
              font=regular, fill=white)

    # Tarja inferior em duas camadas para leitura mesmo em imagens claras.
    draw.rounded_rectangle((42, 1350, 1038, 1868), radius=34,
                           fill=(4, 17, 31, 232), outline=(28, 210, 224, 220), width=3)
    draw.rounded_rectangle((76, 1390, 88, 1818), radius=6, fill=cyan)
    eyebrow = ImageFont.truetype(FONT_BOLD, 26)
    draw.text((120, 1400), "NOTÍCIA EM 60 SEGUNDOS", font=eyebrow, fill=cyan)

    max_width = 850
    words = headline.replace("\n", " ").split()
    chosen = None
    lines = []
    for size in (66, 60, 56, 52, 48, 44):
        font = ImageFont.truetype(FONT_BOLD, size)
        candidate_lines, current = [], ""
        for word in words:
            test = (current + " " + word).strip()
            if draw.textbbox((0, 0), test, font=font)[2] > max_width and current:
                candidate_lines.append(current)
                current = word
            else:
                current = test
        if current:
            candidate_lines.append(current)
        if len(candidate_lines) <= 3:
            chosen, lines = font, candidate_lines
            break
    if chosen is None:
        chosen = ImageFont.truetype(FONT_BOLD, 42)
        lines, current = [], ""
        for word in words:
            test = (current + " " + word).strip()
            if draw.textbbox((0, 0), test, font=chosen)[2] > max_width and current:
                lines.append(current)
                current = word
            else:
                current = test
        if current:
            lines.append(current)
        lines = lines[:4]

    y = 1465
    line_height = chosen.size + 17
    for line in lines:
        draw.text((120, y), line, font=chosen, fill=white,
                  stroke_width=1, stroke_fill=(0, 0, 0, 255))
        y += line_height

    date_font = ImageFont.truetype(FONT_REGULAR, 22)
    draw.text((120, 1820), f"O SEU RADAR  |  {edition_date}",
              font=date_font, fill=muted)
    canvas.save(path)


def render_shorts(images, audio, duration, output, work_dir, headline, edition_date):
    """Cria clipes individuais com zoom suave e transições entre imagens."""
    images = images[:4]
    overlay = work_dir / "short-overlay.png"
    make_short_overlay(overlay, headline, edition_date)

    overlap = 0.45
    clip_duration = (duration + overlap * (len(images) - 1)) / len(images)
    command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
               "-filter_complex_threads", "1"]
    for image in images:
        command += ["-loop", "1", "-framerate", "30",
                    "-t", f"{clip_duration:.4f}", "-i", str(image)]
    audio_index = len(images)
    command += ["-i", str(audio),
                "-loop", "1", "-framerate", "30",
                "-t", f"{duration:.4f}", "-i", str(overlay)]

    filters = []
    for index in range(len(images)):
        filters.append(
            f"[{index}:v]scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,"
            "zoompan=z='min(zoom+0.00065,1.10)':"
            "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            "d=1:s=1080x1920:fps=30,setsar=1,format=yuv420p"
            f"[scene{index}]"
        )

    current = "scene0"
    if len(images) == 1:
        base = "[scene0]"
    else:
        for index in range(1, len(images)):
            next_label = f"transition{index}"
            offset = index * (clip_duration - overlap)
            filters.append(
                f"[{current}][scene{index}]xfade=transition=fade:"
                f"duration={overlap}:offset={offset:.4f}[{next_label}]"
            )
            current = next_label
        base = f"[{current}]"

    overlay_index = len(images) + 1
    filters.append(
        f"{base}[{overlay_index}:v]overlay=0:0:shortest=1:format=auto,"
        "format=yuv420p[vout]"
    )
    command += ["-filter_complex", ";".join(filters),
                "-map", "[vout]", "-map", f"{audio_index}:a:0",
                "-t", f"{duration:.3f}", "-r", "30",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart", str(output)]
    run(command)


def render_landscape(images, audio, duration, output, work_dir, headline):
    """Mantém compatibilidade com o formato horizontal legado."""
    concat_file = work_dir / "images.txt"
    headline_file = work_dir / "headline.txt"
    headline_file.write_text(headline.replace("\n", " ").strip(), encoding="utf-8")
    seconds_per_image = duration / len(images)
    lines = []
    for image in images:
        lines += [f"file '{str(image.resolve()).replace(chr(39), chr(92)+chr(39))}'",
                  f"duration {seconds_per_image:.6f}"]
    lines.append(f"file '{str(images[-1].resolve()).replace(chr(39), chr(92)+chr(39))}'")
    concat_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    video_filter = (
        "scale=1920:1080:force_original_aspect_ratio=decrease,"
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x101820,setsar=1,"
        "drawbox=x=0:y=ih-190:w=iw:h=190:color=0x071521@0.88:t=fill,"
        f"drawtext=fontfile={FONT_BOLD}:textfile={headline_file}:"
        "fontcolor=white:fontsize=46:x=80:y=h-145:box=0"
    )
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
         "-f", "concat", "-safe", "0", "-i", str(concat_file), "-i", str(audio),
         "-vf", video_filter, "-map", "0:v:0", "-map", "1:a:0",
         "-t", f"{duration:.3f}", "-r", "30", "-c:v", "libx264",
         "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output)])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, help="Caminho do áudio WAV aprovado")
    parser.add_argument("--images", required=True, help="Pasta com imagens da edição")
    parser.add_argument("--headline", required=True, help="Manchete exibida na tarja")
    parser.add_argument("--date", required=True, help="Data da edição (AAAA-MM-DD)")
    parser.add_argument("--output-dir", default="output")
    parser.add_argument("--format", choices=("landscape", "shorts"), default="landscape")
    args = parser.parse_args()

    audio = Path(args.audio).resolve()
    image_dir = Path(args.images).resolve()
    output_dir = Path(args.output_dir).resolve()
    if not audio.is_file():
        raise SystemExit(f"Áudio não encontrado: {audio}")
    if audio.suffix.lower() != ".wav":
        raise SystemExit("O áudio precisa estar no formato WAV.")
    if not image_dir.is_dir():
        raise SystemExit(f"Pasta de imagens não encontrada: {image_dir}")

    images = sorted(p for p in image_dir.iterdir()
                    if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)
    if not images:
        raise SystemExit("Nenhuma imagem aprovada ou arte ilustrativa encontrada.")
    duration = probe_duration(audio)
    if args.format == "shorts" and duration > 60:
        raise SystemExit(
            f"Áudio do Short tem {duration:.1f} segundos; limite de 60 segundos. "
            "Vídeo não será montado."
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    work_dir = output_dir / "_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f"radar-diario-{args.date}.mp4"
    if args.format == "shorts":
        render_shorts(images, audio, duration, output, work_dir,
                      args.headline, args.date)
    else:
        render_landscape(images, audio, duration, output, work_dir, args.headline)

    print(f"Vídeo criado: {output}")
    print(f"Duração do áudio: {duration:.1f} segundos")
    print(f"Imagens/cenas utilizadas: {min(len(images), 4) if args.format == 'shorts' else len(images)}")


if __name__ == "__main__":
    main()
