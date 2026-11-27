#!/usr/bin/env python3
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FPS = 30
WIDTH = 1920
HEIGHT = 1080


def run(command):
    subprocess.run(command, check=True)


def inside_repo(value, label):
    path = (ROOT / value).resolve()
    if path != ROOT and ROOT not in path.parents:
        raise ValueError(f"Caminho de {label} precisa ficar dentro do repositório: {value}")
    if not path.is_file():
        raise FileNotFoundError(f"Arquivo de {label} não encontrado: {value}")
    return path


def probe_duration(audio):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(audio)],
        check=True, capture_output=True, text=True
    )
    duration = float(result.stdout.strip())
    if duration <= 0:
        raise ValueError("Não foi possível identificar a duração do áudio.")
    return duration


def main():
    parser = argparse.ArgumentParser(description="Monta o vídeo do Radar Diário.")
    parser.add_argument("--manifest", required=True, help="Caminho do manifesto JSON.")
    parser.add_argument("--output", default="output/radar-diario.mp4", help="Caminho do MP4 final.")
    args = parser.parse_args()

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("FFmpeg e ffprobe precisam estar instalados.")

    manifest_path = inside_repo(args.manifest, "manifesto")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    audio = inside_repo(data["audio"], "áudio")
    segments = data.get("segments", [])
    if not segments:
        raise ValueError("O manifesto precisa conter ao menos uma notícia.")

    images = []
    for index, segment in enumerate(segments, start=1):
        if not segment.get("title") or not segment.get("image"):
            raise ValueError(f"A notícia {index} precisa de title e image.")
        images.append(inside_repo(segment["image"], f"imagem da notícia {index}"))

    total_duration = probe_duration(audio)
    explicit = [segment.get("seconds") for segment in segments]
    if all(value is None for value in explicit):
        durations = [total_duration / len(segments)] * len(segments)
    elif any(value is None for value in explicit):
        raise ValueError("Informe seconds em todas as notícias ou em nenhuma.")
    else:
        durations = [float(value) for value in explicit]
        if any(value <= 0 for value in durations):
            raise ValueError("Todas as durações precisam ser maiores que zero.")
        if abs(sum(durations) - total_duration) > 2:
            raise ValueError(
                f"A soma das durações ({sum(durations):.2f}s) deve corresponder "
                f"ao áudio ({total_duration:.2f}s), com tolerância de 2s."
            )

    output = (ROOT / args.output).resolve()
    if output != ROOT and ROOT not in output.parents:
        raise ValueError("O caminho de saída precisa ficar dentro do repositório.")
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="radar-video-") as temp_name:
        temp = Path(temp_name)
        clip_paths = []
        concat_file = temp / "concat.txt"
        font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

        for index, (segment, image, duration) in enumerate(zip(segments, images, durations), start=1):
            title_file = temp / f"title-{index:02d}.txt"
            title_file.write_text(str(segment["title"]).replace("\\", "\\\\"), encoding="utf-8")
            clip = temp / f"clip-{index:02d}.mp4"
            filter_value = (
                f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,"
                f"crop={WIDTH}:{HEIGHT},"
                f"drawtext=fontfile={font}:textfile={title_file}:expansion=none:"
                "fontsize=48:fontcolor=white:box=1:boxcolor=black@0.62:"
                "boxborderw=28:x=80:y=h-th-90"
            )
            run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-loop", "1", "-framerate", str(FPS), "-i", str(image),
                "-t", f"{duration:.3f}", "-vf", filter_value,
                "-r", str(FPS), "-an", "-c:v", "libx264", "-preset", "veryfast",
                "-crf", "22", "-pix_fmt", "yuv420p", str(clip)
            ])
            clip_paths.append(clip)

        concat_file.write_text(
            "".join(f"file '{path.as_posix()}'\n" for path in clip_paths),
            encoding="utf-8"
        )
        silent_video = temp / "video-silent.mp4"
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0", "-i", str(concat_file),
            "-c", "copy", str(silent_video)
        ])
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(silent_video), "-i", str(audio),
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-shortest", "-movflags", "+faststart", str(output)
        ])

    print(f"Vídeo criado: {output.relative_to(ROOT)}")
    print(f"Duração do áudio: {total_duration:.1f} segundos")
    print(f"Notícias/imagens: {len(segments)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERRO: {error}", file=sys.stderr)
        sys.exit(1)
