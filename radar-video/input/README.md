# Produção de YouTube Shorts — O Seu Radar

O workflow **O Seu Radar — produção de YouTube Shorts** seleciona uma notícia recente de Tecnologia da Informação ou Inteligência Artificial, cria um roteiro original de 95 a 115 palavras, gera a narração com o Piper TTS existente, obtém uma imagem reutilizável do Wikimedia Commons (ou cria uma arte identificada como ilustrativa) e monta um MP4 vertical 9:16.

## Configuração necessária

No GitHub, em **Settings → Secrets and variables → Actions**, mantenha os secrets já cadastrados:

- `GEMINI_API_KEY`
- `PIPER_API_KEY`

Não cole chaves em arquivos, issues ou mensagens. O endereço do Piper já está configurado no workflow.

## Como executar

1. Abra a aba **Actions** do repositório.
2. Escolha **O Seu Radar — produção de YouTube Shorts**.
3. Clique em **Run workflow** na branch `main`.
4. Mantenha inicialmente a janela de 36 horas e o limite de 40 notícias candidatas.
5. Aguarde o artefato e baixe o MP4 para revisão.

## Regras editoriais e técnicas

- Um Short por execução, com exatamente uma notícia de TI ou IA.
- Narração de 95 a 115 palavras, com meta de aproximadamente 45–55 segundos e limite rígido de 60 segundos no renderizador.
- Vídeo vertical 1080×1920 (9:16), 30 fps.
- A narração usa uma requisição curta do Piper sempre que o texto couber no limite de 900 caracteres por trecho.
- A validação do roteiro impede a montagem quando o texto excede a faixa definida.
- Imagens Wikimedia são usadas somente com licença CC0, domínio público ou CC BY; créditos são registrados. Quando não há imagem adequada, é criada uma arte identificada como ilustrativa.
- A execução é manual. Não há publicação automática no YouTube.
- Roteiro, áudio e vídeo exigem aprovação editorial humana.
- Os artefatos ficam disponíveis por 7 dias.
- Não é necessário fornecer WAV nem imagens manualmente.
