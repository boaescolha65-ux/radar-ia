# Arquivos de entrada do Radar Diário

Antes de executar o workflow **Radar Diário — produção de vídeo**, coloque nesta estrutura:

- `audio.wav`: narração completa, já revisada e aprovada, em WAV.
- `images/`: imagens autorizadas para a edição, em JPG, JPEG, PNG ou WebP.

## Importante

1. Não coloque chaves, tokens ou credenciais nesta pasta.
2. Use apenas áudio e imagens que você tenha autorização para utilizar.
3. Nomeie as imagens em ordem de exibição, por exemplo: `01-abertura.jpg`, `02-noticia.jpg`, `03-analise.jpg`.
4. O workflow atual distribui as imagens igualmente ao longo da duração do áudio.
5. O vídeo gerado é apenas um artefato para revisão; não há publicação automática no YouTube.

O arquivo WAV e as imagens não foram incluídos neste commit. Eles precisam ser adicionados antes do primeiro teste.
