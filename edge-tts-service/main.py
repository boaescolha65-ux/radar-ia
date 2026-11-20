import asyncio
import hmac
import os
from io import BytesIO

import edge_tts
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

app = FastAPI(title="O Seu Radar — Edge TTS", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://oseuradar.com.br",
        "https://www.oseuradar.com.br",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

VOICE = os.getenv("EDGE_TTS_VOICE", "pt-BR-FranciscaNeural")
API_KEY = os.getenv("EDGE_TTS_API_KEY", "")
MAX_TEXT_CHARS = 1400
_generation_limit = asyncio.Semaphore(2)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "edge-tts", "voice": VOICE}


@app.post("/api/tts")
async def synthesize(
    payload: TTSRequest,
    authorization: str | None = Header(default=None),
):
    if not API_KEY:
        raise HTTPException(status_code=503, detail="EDGE_TTS_API_KEY não configurada.")
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
            communicate = edge_tts.Communicate(
                text,
                VOICE,
                rate="+0%",
                volume="+0%",
                pitch="+0Hz",
            )
            audio = BytesIO()
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio":
                    audio.write(chunk["data"])
            result = audio.getvalue()

        if not result:
            raise RuntimeError("O serviço Edge TTS não retornou áudio.")

        return Response(
            content=result,
            media_type="audio/mpeg",
            headers={
                "Cache-Control": "no-store",
                "X-TTS-Voice": VOICE,
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Edge TTS synthesis error: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=502,
            detail="Não foi possível gerar o áudio. Tente novamente.",
        ) from exc
