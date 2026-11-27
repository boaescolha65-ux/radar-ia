import asyncio
import gc
import hmac
import json
import os
import resource
import tempfile
import time
import wave
from contextlib import asynccontextmanager
from pathlib import Path

from starlette.background import BackgroundTask
from fastapi.responses import FileResponse

import onnxruntime as ort
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from piper import PiperVoice
from piper.config import PiperConfig

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = Path(os.getenv("PIPER_MODEL_PATH", str(BASE_DIR / "voices" / "pt_BR-faber-medium.onnx")))
CONFIG_PATH = Path(str(MODEL_PATH) + ".json")
VOICE_NAME = "pt_BR-faber-medium"
API_KEY = os.getenv("PIPER_API_KEY", "")
MAX_TEXT_CHARS = 1400
_generation_limit = asyncio.Semaphore(1)
_voice: PiperVoice | None = None


def memory_peak_mb() -> int:
    # Render runs Linux; ru_maxrss is reported in KiB.
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _voice
    if not MODEL_PATH.is_file():
        raise RuntimeError(f"Modelo Piper não encontrado: {MODEL_PATH}")
    if not CONFIG_PATH.is_file():
        raise RuntimeError(f"Configuração Piper não encontrada: {CONFIG_PATH}")

    # Render Free has a tight RAM/CPU budget. Limit ONNX threads and disable
    # memory arenas/patterns to avoid oversized thread pools and retained buffers.
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    options.log_severity_level = 3

    with CONFIG_PATH.open("r", encoding="utf-8") as config_file:
        config = PiperConfig.from_dict(json.load(config_file))

    started = time.monotonic()
    session = ort.InferenceSession(
        str(MODEL_PATH),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    _voice = PiperVoice(config=config, session=session)
    print(
        f"Piper pronto: {VOICE_NAME}; "
        f"load_seconds={time.monotonic() - started:.1f}; "
        f"peak_rss_mb={memory_peak_mb()}"
    )
    yield
    _voice = None


app = FastAPI(
    title="O Seu Radar — Piper TTS",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://oseuradar.com.br", "https://www.oseuradar.com.br"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)


@app.api_route("/", methods=["GET", "HEAD"])
async def root():
    return {"service": "piper-tts", "status": "ok" if _voice is not None else "starting"}


@app.get("/health")
async def health():
    return {
        "status": "ok" if _voice is not None else "starting",
        "service": "piper-tts",
        "voice": VOICE_NAME,
        "model_loaded": _voice is not None,
        "peak_rss_mb": memory_peak_mb(),
    }


def _split_for_low_memory(text: str, max_chars: int = 220) -> list[str]:
    """Divide trechos longos antes da inferência para limitar o pico de RAM."""
    words = text.split()
    parts: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and len(candidate) > max_chars:
            parts.append(current)
            current = word
        else:
            current = candidate
    if current:
        parts.append(current)
    return parts


def _synthesize_wav_file(text: str) -> str:
    if _voice is None:
        raise RuntimeError("Modelo Piper ainda não foi carregado.")

    fd, output_path = tempfile.mkstemp(prefix="piper-", suffix=".wav")
    os.close(fd)
    try:
        with wave.open(output_path, "wb") as wav_file:
            first_part = True
            for part in _split_for_low_memory(text):
                _voice.synthesize_wav(
                    part,
                    wav_file,
                    set_wav_format=first_part,
                )
                first_part = False
                # Libera arrays temporários de áudio antes da próxima inferência.
                gc.collect()
        return output_path
    except Exception:
        try:
            os.unlink(output_path)
        except OSError:
            pass
        raise


def _remove_temp_audio(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


@app.post("/api/tts")
async def synthesize(
    payload: TTSRequest,
    authorization: str | None = Header(default=None),
):
    text = payload.text.strip()
    print(
        f"TTS request received: chars={len(text)}; "
        f"api_key_configured={bool(API_KEY)}; "
        f"authorization_present={bool(authorization)}"
    )
    if not API_KEY:
        print("TTS rejected: PIPER_API_KEY ausente no ambiente do Render.")
        raise HTTPException(status_code=503, detail="PIPER_API_KEY não configurada no serviço.")
    expected = f"Bearer {API_KEY}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        print("TTS rejected: falha de autenticação Bearer.")
        raise HTTPException(status_code=401, detail="Não autorizado.")
    if not text:
        raise HTTPException(status_code=400, detail="Texto vazio.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=413, detail="Trecho excede 1.400 caracteres.")

    started = time.monotonic()
    output_path = None
    try:
        async with _generation_limit:
            output_path = await asyncio.to_thread(_synthesize_wav_file, text)

        audio_bytes = os.path.getsize(output_path)
        if audio_bytes <= 44:
            raise RuntimeError("O Piper não retornou áudio WAV válido.")
        if audio_bytes > 4 * 1024 * 1024:
            raise RuntimeError("O WAV gerado excedeu o limite de 4 MB.")

        elapsed = time.monotonic() - started
        print(
            f"Piper TTS OK: chars={len(text)}; audio_bytes={audio_bytes}; "
            f"seconds={elapsed:.1f}; peak_rss_mb={memory_peak_mb()}"
        )
        response = FileResponse(
            output_path,
            media_type="audio/wav",
            headers={
                "Cache-Control": "no-store",
                "X-TTS-Voice": VOICE_NAME,
            },
            background=BackgroundTask(_remove_temp_audio, output_path),
        )
        output_path = None  # A limpeza fica a cargo do BackgroundTask.
        return response
    except HTTPException:
        raise
    except Exception as exc:
        if output_path:
            _remove_temp_audio(output_path)
        print(
            f"Piper TTS synthesis error: {type(exc).__name__}: {exc}; "
            f"peak_rss_mb={memory_peak_mb()}"
        )
        raise HTTPException(
            status_code=502,
            detail="Não foi possível gerar o áudio. Tente novamente.",
        ) from exc
