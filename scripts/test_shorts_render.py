#!/usr/bin/env python3
"""Teste de integração do renderizador: formato, movimento real e legendas."""
import json
import math
import struct
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from PIL import Image, ImageChops

from render_radar_video import render_shorts, probe_duration


class ShortsRenderTest(unittest.TestCase):
    def test_motion_captions_and_vertical_video(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            images_dir = root / "images"
            work_dir = root / "work"
            images_dir.mkdir()
            work_dir.mkdir()

            # Imagens com textura permitem detectar movimento no conteúdo, não só nas tarjas.
            for index, base in enumerate(((20, 80, 120), (110, 55, 25))):
                image = Image.new("RGB", (1200, 2000))
                pixels = image.load()
                for y in range(image.height):
                    for x in range(image.width):
                        pixels[x, y] = (
                            min(255, base[0] + (x // 12) % 80),
                            min(255, base[1] + (y // 18) % 90),
                            min(255, base[2] + ((x + y) // 24) % 70),
                        )
                image.save(images_dir / f"{index + 1:02d}.jpg", quality=92)

            audio = root / "sample.wav"
            sample_rate, seconds = 16000, 8
            with wave.open(str(audio), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(sample_rate)
                samples = bytearray()
                for n in range(sample_rate * seconds):
                    value = int(5000 * math.sin(2 * math.pi * 220 * n / sample_rate))
                    samples.extend(struct.pack("<h", value))
                wav.writeframes(samples)

            output = root / "short.mp4"
            images = sorted(images_dir.glob("*.jpg"))
            narration = (
                "A inteligência artificial está mudando a tecnologia. "
                "A novidade pode transformar serviços digitais e ampliar o acesso. "
                "Especialistas acompanham os próximos passos."
            )
            render_shorts(images, audio, float(seconds), output, work_dir,
                          "Inteligência artificial transforma serviços digitais",
                          "2026-11-27", narration)
            self.assertTrue(output.is_file())
            self.assertGreater(output.stat().st_size, 10000)
            self.assertLessEqual(probe_duration(audio), 60)

            result = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=width,height", "-of", "json", str(output)],
                check=True, capture_output=True, text=True,
            )
            stream = json.loads(result.stdout)["streams"][0]
            self.assertEqual(stream["width"], 1080)
            self.assertEqual(stream["height"], 1920)

            # Compara o miolo da mesma cena em instantes diferentes: precisa haver movimento.
            frames = []
            for timestamp in ("0.7", "2.7"):
                frame = root / f"frame-{timestamp}.png"
                subprocess.run(
                    ["ffmpeg", "-y", "-ss", timestamp, "-i", str(output),
                     "-frames:v", "1", str(frame)],
                    check=True, capture_output=True,
                )
                with Image.open(frame) as img:
                    frames.append(img.convert("RGB").crop((180, 250, 900, 1320)))
            difference = ImageChops.difference(frames[0], frames[1])
            mean_difference = sum(difference.convert("L").getdata()) / (720 * 1070)
            self.assertGreater(mean_difference, 0.5, "A imagem permaneceu estática; zoom/pan não funcionou.")

            ass = (work_dir / "captions.ass").read_text(encoding="utf-8")
            self.assertIn("Dialogue:", ass)
            self.assertIn("inteligência artificial", ass.lower())


if __name__ == "__main__":
    unittest.main()
