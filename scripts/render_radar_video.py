#!/usr/bin/env python3
"""Renderizador do O Seu Radar: Shorts verticais com movimento e legendas dinâmicas."""
import argparse
import json
import re
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
WIDTH, HEIGHT, FPS = 1080, 1920, 30


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
    """Cria identidade visual vertical com áreas seguras e manchete legível."""
    canvas = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    cyan, white = (28, 210, 224, 255), (250, 252, 255, 255)
    muted = (190, 213, 224, 255)
    bold = ImageFont.truetype(FONT_BOLD, 34)
    regular = ImageFont.truetype(FONT_REGULAR, 22)

    draw.rounded_rectangle((48, 52, 650, 166), radius=25,
                           fill=(5, 22, 38, 220), outline=(28, 210, 224, 210), width=3)
    draw.text((76, 65), "O SEU RADAR", font=bold, fill=cyan)
    draw.text((78, 116), "TECNOLOGIA  •  INTELIGÊNCIA ARTIFICIAL",
              font=regular, fill=white)

    # Tarja de manchete fica na zona inferior, preservando área central para legendas.
    draw.rounded_rectangle((42, 1450, 1038, 1874), radius=32,
                           fill=(4, 17, 31, 238), outline=(28, 210, 224, 220), width=3)
    draw.rounded_rectangle((76, 1484, 88, 1828), radius=6, fill=cyan)
    eyebrow = ImageFont.truetype(FONT_BOLD, 24)
    draw.text((116, 1488), "NOTÍCIA EM 60 SEGUNDOS", font=eyebrow, fill=cyan)

    max_width = 850
    words = headline.replace("\n", " ").split()
    chosen, lines = None, []
    for size in (58, 54, 50, 46, 42, 38):
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
        chosen = ImageFont.truetype(FONT_BOLD, 36)
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

    y = 1540
    line_height = chosen.size + 13
    for line in lines:
        draw.text((116, y), line, font=chosen, fill=white,
                  stroke_width=1, stroke_fill=(0, 0, 0, 255))
        y += line_height

    date_font = ImageFont.truetype(FONT_REGULAR, 20)
    draw.text((116, 1830), f"O SEU RADAR  |  {edition_date}",
              font=date_font, fill=muted)
    canvas.save(path)


def ass_time(seconds):
    centiseconds = max(0, int(round(seconds * 100)))
    hours, remainder = divmod(centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    whole_seconds, cs = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{cs:02d}"


def make_dynamic_captions(path, narration, duration):
    """Distribui frases curtas ao longo do áudio e as queima em área segura vertical."""
    words = re.findall(r"\S+", narration or "")
    if not words:
        words = ["Acompanhe", "as", "notícias", "de", "tecnologia", "e", "inteligência", "artificial."]
    groups, current = [], []
    for word in words:
        current.append(word)
        if len(current) >= 6 or re.search(r"[.!?;:]$", word):
            groups.append(current)
            current = []
    if current:
        groups.append(current)

    # Evita flashes de legenda: cada cartão recebe tempo proporcional ao número de palavras.
    weights = [max(1, len(group)) for group in groups]
    total_weight = sum(weights)
    cursor = 0.0
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1080",
        "PlayResY: 1920",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Radar,DejaVu Sans,58,&H00FFFFFF,&H0000FFFF,&H00101824,&HCC061522,-1,0,0,0,100,100,0,0,1,4,1,2,90,90,500,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for index, group in enumerate(groups):
        start = cursor
        end = duration if index == len(groups) - 1 else cursor + duration * weights[index] / total_weight
        cursor = end
        if end - start < 0.65:
            end = min(duration, start + 0.65)
        text = " ".join(group)
        # Quebra em até duas linhas para leitura em telas pequenas.
        parts, line = [], ""
        for word in text.split():
            candidate = (line + " " + word).strip()
            if len(candidate) > 28 and line:
                parts.append(line)
                line = word
            else:
                line = candidate
        if line:
            parts.append(line)
        caption = r"\N".join(parts[:2])
        caption = caption.replace("{", r"\{").replace("}", r"\}")
        lines.append(
            f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Radar,,0,0,0,,{caption}"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def render_shorts(images, audio, duration, output, work_dir, headline,
                  edition_date, narration):
    """Cria cenas com zoom/pan contínuos, transições, legendas e barra de progresso."""
    images = images[:4]
    overlay = work_dir / "short-overlay.png"
    captions = work_dir / "captions.ass"
    make_short_overlay(overlay, headline, edition_date)
    make_dynamic_captions(captions, narration, duration)

    overlap = 0.45
    clip_duration = (duration + overlap * (len(images) - 1)) / len(images)
    command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
               "-filter_complex_threads", "1"]
    for image in images:
        command += ["-loop", "1", "-framerate", str(FPS),
                    "-t", f"{clip_duration:.4f}", "-i", str(image)]
    audio_index = len(images)
    command += ["-i", str(audio), "-loop", "1", "-framerate", str(FPS),
                "-t", f"{duration:.4f}", "-i", str(overlay)]

    filters = []
    for index in range(len(images)):
        # on controla o movimento quadro a quadro; o deslocamento alterna o sentido.
        direction = 1 if index % 2 == 0 else -1
        filters.append(
            f"[{index}:v]scale=1200:2134:force_original_aspect_ratio=increase,"
            "crop=1200:2134,"
            f"zoompan=z='min(1+on*0.0009,1.14)':"
            f"x='iw/2-(iw/zoom/2)+{direction}*min(on*0.16,24)':"
            "y='ih/2-(ih/zoom/2)':"
            f"d=1:s={WIDTH}x{HEIGHT}:fps={FPS},setsar=1,format=yuv420p"
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
                f"[{current}][scene{index}]xfade=transition=smoothleft:"
                f"duration={overlap}:offset={offset:.4f}[{next_label}]"
            )
            current = next_label
        base = f"[{current}]"

    overlay_index = len(images) + 1
    caption_path = str(captions.resolve()).replace("\\", "/").replace(":", r"\:")
    filters.append(
        f"{base}[{overlay_index}:v]overlay=0:0:shortest=1:format=auto,"
        f"drawbox=x=0:y=0:w='iw*t/{duration:.4f}':h=12:color=0x1CD2E0:t=fill,"
        f"subtitles=filename='{caption_path}':fontsdir='/usr/share/fonts/truetype/dejavu',"
        "format=yuv420p[vout]"
    )
    command += ["-filter_complex", ";".join(filters),
                "-map", "[vout]", "-map", f"{audio_index}:a:0",
                "-t", f"{duration:.3f}", "-r", str(FPS),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
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
    parser.add_argument("--script", help="JSON do roteiro para gerar legendas sincronizadas")
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

    narration = ""
    if args.script:
        script = json.loads(Path(args.script).read_text(encoding="utf-8"))
        narration = " ".join(
            part for part in (
                script.get("opening", ""),
                script["stories"][0].get("headline", ""),
                script["stories"][0].get("narration", ""),
                script.get("closing", ""),
            ) if part
        )
    output_dir.mkdir(parents=True, exist_ok=True)
    work_dir = output_dir / "_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f"radar-diario-{args.date}.mp4"
    if args.format == "shorts":
        render_shorts(images, audio, duration, output, work_dir,
                      args.headline, args.date, narration)
    else:
        render_landscape(images, audio, duration, output, work_dir, args.headline)

    print(f"Vídeo criado: {output}")
    print(f"Duração do áudio: {duration:.1f} segundos")
    print(f"Imagens/cenas utilizadas: {min(len(images), 4) if args.format == 'shorts' else len(images)}")
    if args.format == "shorts":
        print("Movimento por quadro: zoom/pan; transições; legendas dinâmicas; barra de progresso.")


if __name__ == "__main__":
    main()
