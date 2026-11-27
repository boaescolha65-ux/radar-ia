# Produção de vídeo — O Seu Radar

Este diretório contém o manifesto de entrada e as instruções para a montagem do telejornal pelo GitHub Actions.

## Entradas necessárias

1. Uma narração completa em WAV, exportada pelo estúdio Radar Diário.
2. Uma imagem para cada notícia, em JPG ou PNG.
3. Um manifesto JSON baseado em `manifest.example.json`.

Por padrão, os arquivos de entrada ficam em `video/input/`. Essa pasta não precisa ser versionada com materiais reais; coloque nela os arquivos da edição que será produzida.

## Manifesto

Copie `manifest.example.json` para `video/manifest.json` e ajuste:

- `date`: data da edição.
- `audio`: caminho do WAV completo.
- `segments`: uma entrada por notícia, com `title` e `image`.

A duração total do vídeo é obtida do arquivo de áudio. Se não informar `seconds` em cada notícia, o tempo será dividido igualmente entre as imagens. Se informar `seconds`, todas as notícias devem ter duração definida e a soma deve corresponder à duração do áudio (tolerância de 2 segundos).

## Executar

No GitHub, abra **Actions** → **Radar Diário — produção de vídeo** → **Run workflow**. Informe o caminho do manifesto (padrão: `video/manifest.json`).

O MP4 será disponibilizado como artefato da execução, por 7 dias. A montagem não publica nada no YouTube nem altera o site.

## Observações

- A montagem inicial usa imagens estáticas com enquadramento 16:9 e tarja de título.
- Use apenas imagens próprias, licenciadas ou com autorização de uso.
- O workflow é manual e isolado dos workflows de validação e do Worker.
- O áudio precisa estar pronto e revisado antes da montagem.
