#!/usr/bin/env python3
"""Monta um vídeo MP4 do Radar Diário a partir de um WAV e imagens aprovadas."""
import argparse
import json
import subprocess
from pathlib import Path

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def run(command):
    subprocess.run(command, check=True)


def probe_duration(audio_path):
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "json", str(audio_path),
        ],
        check=True, capture_output=True, text=True,
    )
    duration = float(json.loads(result.stdout)["format"]["duration"])
    if duration <= 0:
        raise ValueError("Não foi possível identificar a duração do áudio.")
    return duration


def concat_escape(path):
    return str(path.resolve()).replace("'", "'\\''")


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

    images = sorted(
        p for p in image_dir.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
    )
    if not images:
        raise SystemExit("Adicione pelo menos uma imagem JPG, PNG ou WebP à pasta informada.")

    duration = probe_duration(audio)
    output_dir.mkdir(parents=True, exist_ok=True)
    work_dir = output_dir / "_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    concat_file = work_dir / "images.txt"
    headline_file = work_dir / "headline.txt"
    headline_file.write_text(args.headline.replace("\n", " ").strip(), encoding="utf-8")

    seconds_per_image = duration / len(images)
    lines = []
    for image in images:
        lines.append(f"file '{concat_escape(image)}'")
        lines.append(f"duration {seconds_per_image:.6f}")
    # O concat demuxer exige repetir o último quadro para aplicar sua duração.
    lines.append(f"file '{concat_escape(images[-1])}'")
    concat_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    output = output_dir / f"radar-diario-{args.date}.mp4"
    if args.format == "shorts":
        video_filter = (
            "scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,setsar=1,"
            "drawbox=x=0:y=ih-520:w=iw:h=520:color=0x071521@0.88:t=fill,"
            f"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:"
            f"textfile={headline_file}:fontcolor=white:fontsize=58:"
            "x=70:y=h-420:box=0"
        )
    else:
        video_filter = (
            "scale=1920:1080:force_original_aspect_ratio=decrease,"
            "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x101820,"
            "setsar=1,"
            "drawbox=x=0:y=ih-190:w=iw:h=190:color=0x071521@0.88:t=fill,"
            f"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:"
            f"textfile={headline_file}:fontcolor=white:fontsize=46:"
            "x=80:y=h-145:box=0"
        )

    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
        "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-i", str(audio),
        "-vf", video_filter,
        "-map", "0:v:0", "-map", "1:a:0",
        "-t", f"{duration:.3f}", "-r", "30",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", str(output),
    ])

    print(f"Vídeo criado: {output}")
    print(f"Duração do áudio: {duration:.1f} segundos")
    print(f"Imagens utilizadas: {len(images)}")


if __name__ == "__main__":
    main()
