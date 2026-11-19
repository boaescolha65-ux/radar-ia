# Google Cloud Text-to-Speech — O Seu Radar

O portal usa **Google Cloud Text-to-Speech com voz Chirp 3 HD em português brasileiro**. O player do site continua usando MP3 real e `HTMLAudioElement.playbackRate`, portanto alterar 1x, 1,25x, 1,5x, 1,75x ou 2x não reinicia a notícia.

> O Cloudflare não é mais o provedor de voz. O Worker continua apenas como uma camada segura de API/proxy para não expor a chave privada do Google no navegador. O áudio é sintetizado pelo Google Cloud.

## 1. Configurar o Google Cloud

1. Abra o [Google Cloud Console](https://console.cloud.google.com/).
2. Crie ou selecione um projeto.
3. Ative **Cloud Text-to-Speech API**: https://console.cloud.google.com/marketplace/product/google/texttospeech.googleapis.com
4. Vincule uma conta de faturamento ao projeto. A API exige faturamento habilitado, mesmo quando o uso permanece dentro da franquia gratuita.
5. Em **IAM e administrador → Contas de serviço**, crie uma conta de serviço.
6. Conceda a função **Cloud Text-to-Speech User** (`roles/cloudtts.user`) à conta.
7. Crie uma chave JSON para essa conta e baixe o arquivo. **Não envie esse arquivo ao GitHub e não o coloque no site.**

## 2. Franquia e voz

A implementação usa `pt-BR-Chirp3-HD-Aoede`, voz feminina HD. O Google lista Chirp 3 HD para português brasileiro.

A tabela oficial consultada informa franquia de **1 milhão de caracteres por mês** para Chirp 3 HD; depois, o preço publicado é **US$ 0,00003 por caractere**. A franquia é mensal e requer faturamento habilitado. Confira os preços e limites atuais antes de liberar tráfego público:
https://cloud.google.com/text-to-speech/pricing

## 3. Configurar o endpoint seguro

No Cloudflare Dashboard, abra o Worker que atende a rota `oseuradar.com.br/api/tts` (o mesmo domínio usado pelo site):

1. Substitua o código antigo pelo arquivo `google-tts-worker.js` deste repositório.
2. Em **Settings → Bindings**, mantenha/crie um binding **KV Namespace** chamado `TTS_KV`. Ele é usado para cache e limite básico de uso.
3. Em **Settings → Variables and Secrets → Secrets**, crie:
   - Nome: `GOOGLE_SERVICE_ACCOUNT_JSON`
   - Valor: cole o conteúdo integral do JSON da conta de serviço baixado no Google Cloud.
4. Faça **Deploy**.
5. Mantenha a rota `oseuradar.com.br/api/tts*` vinculada a esse Worker.

Não configure `AI` nem Workers AI: eles não são usados nesta integração.

## 4. Proteções implementadas

- Até 1.400 caracteres por trecho, compatível com o player atual.
- Até 40 trechos novos por IP em 24 horas (limite básico, não antifraude).
- Cache KV por 14 dias; trechos já armazenados não geram nova chamada paga.
- A credencial privada fica como Secret no Worker e nunca é enviada ao navegador.
- Apenas as origens do portal são aceitas em chamadas de navegador.

## 5. Teste

Depois de cadastrar o Secret, binding KV e publicar o Worker, execute:

```bash
curl -X POST https://oseuradar.com.br/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Este é um teste de narração do portal O Seu Radar."}' \
  --output teste-google.mp3
```

O arquivo `teste-google.mp3` deve ser reproduzível. Depois, teste uma notícia no portal e altere a velocidade durante a reprodução.

## Referências oficiais

- API REST: https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize
- Vozes e idiomas: https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types
- Preços: https://cloud.google.com/text-to-speech/pricing
