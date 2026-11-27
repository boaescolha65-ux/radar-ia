#!/usr/bin/env python3
"""Teste de integração local do renderizador vertical dos Shorts."""
import json
import math
import struct
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from PIL import Image

from render_radar_video import make_short_overlay, render_shorts, probe_duration


class ShortsRenderTest(unittest.TestCase):
    def test_overlay_and_two_scene_video(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            images_dir = root / "images"
            work_dir = root / "work"
            images_dir.mkdir()
            work_dir.mkdir()

            # Imagens sintéticas independentes: o teste não depende de downloads externos.
            Image.new("RGB", (900, 1600), (20, 80, 120)).save(images_dir / "01.jpg")
            Image.new("RGB", (1600, 900), (110, 55, 25)).save(images_dir / "02.jpg")

            overlay = root / "overlay.png"
            make_short_overlay(
                overlay,
                "Inteligência artificial transforma serviços digitais no Brasil",
                "2026-11-27",
            )
            with Image.open(overlay) as img:
                self.assertEqual(img.size, (1080, 1920))
                self.assertEqual(img.mode, "RGBA")

            audio = root / "sample.wav"
            sample_rate = 16000
            seconds = 8
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
            render_shorts(images, audio, float(seconds), output, work_dir,
                          "Manchete de teste com quebra automática", "2026-11-27")
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


if __name__ == "__main__":
    unittest.main()
