# Piper TTS — O Seu Radar

Serviço de síntese de voz independente. Não substitui o serviço Edge TTS existente e não altera o Worker Cloudflare, o player ou suas variáveis.

## Voz

- Modelo: `pt_BR-faber-medium`
- Idioma: português brasileiro
- Formato de saída: WAV, mono, 22.050 Hz (conforme o modelo)
- Limite por requisição: 1.400 caracteres
- Concorrência: uma geração por vez para reduzir o consumo de memória
- Modelo ONNX: aproximadamente 63 MB
- Licença do modelo de voz: MIT
- Licença do pacote `piper-tts`: GPL-3.0-or-later

## Criar um serviço separado no Render

Crie um **novo Web Service** usando este mesmo repositório GitHub. Não edite nem substitua o serviço `edge-tts-service`.

Configurações:

- **Branch:** `main`
- **Root Directory:** `piper-tts-service`
- **Runtime:** Python 3
- **Build Command:**

```bash
pip install -r requirements.txt && mkdir -p voices && curl -fL --retry 3 https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx -o voices/pt_BR-faber-medium.onnx && curl -fL --retry 3 https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx.json -o voices/pt_BR-faber-medium.onnx.json
```

- **Start Command:**

```bash
uvicorn main:app --host 0.0.0.0 --port $PORT
```

Crie no novo serviço uma variável de ambiente:

- `PIPER_API_KEY`: uma chave longa e aleatória, gerada por você.

Não reutilize nem altere a chave do Edge TTS ou qualquer variável do Worker. O endpoint de síntese permanece bloqueado sem essa chave.

Variável opcional:

- `PIPER_MODEL_PATH`: caminho completo do arquivo ONNX, se não usar o caminho padrão.

## Endpoints

- `GET /health`: informa se o serviço e o modelo estão carregados.
- `POST /api/tts`: recebe JSON `{"text":"Texto para narrar"}` e exige `Authorization: Bearer SUA_CHAVE`. Retorna áudio WAV.

Exemplo de teste:

```bash
curl -X POST "https://SEU-SERVICO.onrender.com/api/tts" \
  -H "Authorization: Bearer SUA_PIPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Este é um teste de narração do O Seu Radar."}' \
  --output teste-piper.wav
```

## Observação sobre o plano Free

O modelo é relativamente pequeno, mas a inicialização e a geração de áudio consomem CPU e memória. O plano gratuito do Render pode apresentar inicialização lenta, suspensão por inatividade, lentidão ou falta de memória. O serviço deve passar por teste real com trechos e reportagens longas antes de qualquer integração com o player.

O serviço Edge TTS continua sendo a opção ativa até que o Piper seja implantado e validado. Nenhuma alteração no player ou no Worker faz parte desta etapa.
