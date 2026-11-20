# O Seu Radar — Edge TTS (ambiente de teste)

Serviço Python isolado para testar a voz neural Microsoft Edge TTS em português brasileiro. Ele **não substitui** o endpoint atual do portal.

## Configuração no Render

Crie um Web Service conectado ao repositório `boaescolha65-ux/radar-ia` com:

- **Root Directory:** `edge-tts-service`
- **Runtime:** Python 3
- **Build Command:** `pip install -r requirements.txt`
- **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
- **Instance Type:** Free

Cadastre duas variáveis de ambiente:

- `EDGE_TTS_API_KEY`: gere uma senha longa e aleatória (não use a senha de nenhuma conta).
- `EDGE_TTS_VOICE`: `pt-BR-FranciscaNeural`

Não coloque a chave no GitHub, no navegador ou em mensagens.

## Testes

Após o deploy, abra `https://SEU-SERVICO.onrender.com/health`. Deve retornar JSON com `"status":"ok"`.

O endpoint de áudio é `POST /api/tts`, recebe `{"text":"..." }`, exige `Authorization: Bearer SUA_CHAVE` e retorna MP3.

O Render Free suspende serviços após 15 minutos sem tráfego; a primeira requisição após suspensão pode demorar cerca de um minuto. É apenas para avaliação, não para produção.

## Limitações

Edge TTS usa uma interface online não oficial da Microsoft, por meio da biblioteca comunitária `edge-tts`. A Microsoft pode alterar ou limitar o serviço sem aviso. Não há SLA nem garantia de disponibilidade, volume ou autorização para uso comercial contínuo. Faça testes antes de considerar qualquer uso público.
