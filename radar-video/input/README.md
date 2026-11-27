# Produção automática do Radar Diário

A edição não exige WAV nem imagens fornecidos manualmente. O workflow **Radar Diário — produção automática do telejornal** coleta notícias recentes, gera o roteiro com Gemini, busca imagens reutilizáveis no Wikimedia Commons (ou cria artes ilustrativas quando não encontra imagem compatível), produz a narração pelo Piper TTS existente e monta o MP4 com FFmpeg.

## Configuração necessária — uma única vez

No GitHub, abra **Settings → Secrets and variables → Actions → New repository secret** e cadastre:

- `GEMINI_API_KEY`: chave criada no Google AI Studio.
- `PIPER_API_KEY`: a mesma credencial já usada pelo serviço Piper do Radar, sem publicá-la no repositório.

Não cole as chaves em arquivos, issues ou mensagens. O endereço do Piper já está configurado no workflow.

Opcionalmente, em **Variables**, pode definir `GEMINI_MODEL`; por padrão o fluxo usa `gemini-3.6-flash`.

## Como executar

1. Abra a aba **Actions** do repositório.
2. Escolha **Radar Diário — produção automática do telejornal**.
3. Clique em **Run workflow**.
4. Mantenha a janela de 36 horas e o limite de 40 notícias na primeira execução.
5. Aguarde a geração do artefato e baixe a edição para revisão.

O artefato inclui MP4, WAV, roteiro em JSON e texto, fontes das notícias e créditos/licenças das imagens. Os artefatos ficam disponíveis por 7 dias.

## Regras editoriais e de segurança

- O foco é exclusivamente Tecnologia da Informação e Inteligência Artificial.
- São necessárias de 6 a 8 notícias recentes, com fontes e URLs preservadas.
- O roteiro deve passar pela validação de extensão antes de gerar o áudio.
- Imagens do Wikimedia Commons só são usadas quando a licença identificada é CC0, domínio público ou CC BY; os créditos são registrados. Quando não há imagem adequada, é criada uma arte identificada como ilustrativa.
- A narração é produzida em partes pelo Piper, respeitando o limite de caracteres por requisição.
- A execução é manual. Não há publicação automática no YouTube.
- O roteiro, áudio e vídeo são materiais de prévia e precisam de aprovação editorial humana.
- Nenhuma chave deve ser armazenada nesta pasta ou em qualquer arquivo do Git.

Os arquivos de áudio e imagens são gerados durante a execução e não precisam ser enviados ao repositório.
