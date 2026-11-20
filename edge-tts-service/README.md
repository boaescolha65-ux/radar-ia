# O Seu Radar — serviço de áudio Edge TTS

Serviço isolado para gerar MP3 em português brasileiro. O Worker do Cloudflare é o único ponto de acesso usado pelo site; a chave do Render nunca é exposta ao navegador.

## Configuração do Web Service no Render

- **Root Directory:** `edge-tts-service`
- **Runtime:** Python 3
- **Build Command:** `pip install -r requirements.txt`
- **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`

Variáveis de ambiente do Render:
- `EDGE_TTS_API_KEY`: deve ser exatamente a mesma chave cadastrada como Secret no Cloudflare Worker.
- `EDGE_TTS_VOICE`: `pt-BR-FranciscaNeural` (opcional; já é o padrão).

## Verificação

- GET `/health`: retorna estado do serviço.
- POST `/api/tts`: recebe JSON `{"text":"..." }`, exige `Authorization: Bearer ...` e retorna MP3.

A biblioteca `edge-tts` utiliza um serviço online comunitário não oficial. A disponibilidade, os limites e as condições de uso podem mudar. O plano gratuito do Render pode suspender o serviço após inatividade, aumentando o tempo da primeira resposta.
