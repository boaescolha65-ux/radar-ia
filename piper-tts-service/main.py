import asyncio
import hmac
import os
import wave
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from piper import PiperVoice

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = Path(os.getenv("PIPER_MODEL_PATH", str(BASE_DIR / "voices" / "pt_BR-faber-medium.onnx")))
VOICE_NAME = "pt_BR-faber-medium"
API_KEY = os.getenv("PIPER_API_KEY", "")
MAX_TEXT_CHARS = 1400
_generation_limit = asyncio.Semaphore(1)
_voice: PiperVoice | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _voice
    if not MODEL_PATH.is_file():
        raise RuntimeError(f"Modelo Piper não encontrado: {MODEL_PATH}")
    _voice = PiperVoice.load(str(MODEL_PATH))
    print(f"Piper pronto: {VOICE_NAME}")
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


@app.get("/health")
async def health():
    return {
        "status": "ok" if _voice is not None else "starting",
        "service": "piper-tts",
        "voice": VOICE_NAME,
        "model_loaded": _voice is not None,
    }


def _synthesize_wav(text: str) -> bytes:
    if _voice is None:
        raise RuntimeError("Modelo Piper ainda não foi carregado.")
    output = BytesIO()
    with wave.open(output, "wb") as wav_file:
        _voice.synthesize_wav(text, wav_file)
    return output.getvalue()


@app.post("/api/tts")
async def synthesize(
    payload: TTSRequest,
    authorization: str | None = Header(default=None),
):
    if not API_KEY:
        raise HTTPException(status_code=503, detail="PIPER_API_KEY não configurada no serviço.")
    expected = f"Bearer {API_KEY}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Não autorizado.")

    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Texto vazio.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=413, detail="Trecho excede 1.400 caracteres.")

    try:
        async with _generation_limit:
            audio = await asyncio.to_thread(_synthesize_wav, text)

        if not audio:
            raise RuntimeError("O Piper não retornou áudio.")

        return Response(
            content=audio,
            media_type="audio/wav",
            headers={
                "Cache-Control": "no-store",
                "X-TTS-Voice": VOICE_NAME,
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Piper TTS synthesis error: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=502,
            detail="Não foi possível gerar o áudio. Tente novamente.",
        ) from exc
