# TTS do O Seu Radar (Cloudflare Worker)

Este Worker gera áudio MP3 em português brasileiro com o modelo `xai/grok-tts` e devolve o arquivo ao navegador. O player HTML usa `HTMLAudioElement.playbackRate`, para que a velocidade possa mudar durante a reprodução sem reiniciá-la.

## 1. Criar o Worker

1. No Cloudflare Dashboard, abra **Workers & Pages → Create → Worker**.
2. Nome sugerido: `oseu-radar-tts`.
3. Abra o editor de código e substitua o conteúdo pelo arquivo `audio-tts-worker.js` deste repositório.
4. Em **Settings → Bindings**, adicione:
   - **Workers AI** binding com variável `AI`.
   - **KV Namespace** binding com variável `TTS_KV` (crie um namespace KV e conecte-o).
5. Deploy.

## 2. Rota

Em **Settings → Domains & Routes**, adicione uma rota para o Worker:

`oseuradar.com.br/api/tts*`

Se a rota for configurada para capturar /api/tts, a URL usada no site será `https://oseuradar.com.br/api/tts`. Não publique sem a ligação KV: o endpoint exige KV para limite de requisições e cache.

## 3. Limites e proteção

- Até 1.400 caracteres por solicitação.
- Limite inicial de 40 gerações por IP em 24 horas.
- O cache KV reutiliza o áudio de trechos já gerados por até 14 dias.
- O endpoint aceita origens do portal e rejeita origens de navegador não autorizadas.
- O modelo tem custo por caractere; confirme a página de preço e disponibilidade no painel antes de ativar. A API pode ser alterada pela Cloudflare.

**Nota:** CORS não substitui proteção contra uso automatizado; o limite por IP é uma proteção básica, não antifraude. Monitore custos e ajuste o limite.

## 4. Teste após deploy

Use a URL do domínio (a rota acima) ou, antes de criar a rota, adapte o endereço do Worker no frontend. Teste com:

```bash
curl -X POST https://oseuradar.com.br/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Teste de narração do O Seu Radar em português brasileiro."}' \
  --output teste.mp3
```

O arquivo deve ser MP3. O endpoint não deve ser ativado antes de configurar o binding AI e o namespace KV.

## 5. Modelo e fonte

Modelo: `xai/grok-tts`, idioma `pt-BR`, voz `ara`. Documentação oficial:
https://developers.cloudflare.com/ai/models/xai/grok-tts/
