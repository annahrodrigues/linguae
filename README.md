# Linguae

Um app de aprendizado de idiomas no espírito do Duolingo: trilha de lições, repetição
espaçada, vidas, ofensiva e conquistas. Cinco cursos, todos ensinados **a partir do
inglês** — espanhol, francês, alemão, italiano e latim.

A interface é em inglês. O mascote é o **Leon**, um camaleão.

**App:** https://claude.ai/artifact/Fzbcf54MKVHHP2DgNhnv9K

## Rodando

Não há build, dependências nem servidor. O app inteiro é um arquivo HTML com a pasta
`assets/` ao lado:

```bash
python -m http.server 8000
```

E abra `http://localhost:8000/linguae.html`.

Abrir o arquivo direto por `file://` também funciona, mas o navegador bloqueia parte
das fontes e dos ícones, então prefira servir por HTTP.

## O que tem dentro

| | |
|---|---|
| **Cursos** | 5 idiomas, 7 unidades e 14 lições cada, 112 palavras e frases por curso |
| **Exercícios** | 6 tipos: associar pares, escolher a tradução nos dois sentidos, ouvir e transcrever, montar com banco de palavras, e digitar livre |
| **Correção** | acentos e pontuação são normalizados, e um erro de digitação de uma letra conta como acerto, com aviso |
| **Repetição espaçada** | caixas de Leitner com intervalos de 1, 3, 7, 16 e 35 dias; errou, a palavra volta para a caixa 2 e reaparece na mesma sessão |
| **Progresso** | 5 coroas por lição, XP, meta diária de 30 XP, ofensiva por dia e 9 conquistas |
| **Vidas** | 5 por lição; acabou, a lição recomeça |
| **Áudio** | `speechSynthesis` do navegador; se não houver voz instalada para o idioma, os exercícios de escuta somem sozinhos |
| **Acessibilidade** | todos os pares de texto passam no contraste AA (4.5:1) nos dois temas |

O progresso fica no `localStorage`, por curso, na chave `lingua-trail-v1`. Não há
conta, backend nem rede — fechar a aba não perde nada, trocar de navegador sim.

## Identidade visual

O visual segue o **Linguae Brand Book 1.0** e o **React UI Kit 2.2**, que estão neste
repositório como referência:

- Cores, tipografia (Outfit e DM Sans) e componentes saem do `src/styles.css` do kit
- O símbolo é o monograma vetorial *Hidden Chameleon L* (`linguae-monogram.svg`)
- As expressões do Leon vêm do Kit de Identidade Visual, reduzidas para a web
- O verde de marca `#248F70` é a referência; na interface o texto usa `#1D7A5F`,
  que é o mesmo verde escurecido o suficiente para passar no AA

## Estrutura

```
linguae.html                  o app inteiro
assets/                       o que a página carrega
Linguae_Brand_Kit_1.0.pdf     o manual da marca
Linguae_Kit_Identidade_Visual/  mascote e logo em alta
Linguae_React_UI_Kit_2.2/     o design system em React, de onde vêm os tokens
Linguae_UI_Kit_1.0/           o protótipo HTML/CSS/JS original
```

Dentro do `linguae.html` a ordem é: conteúdo dos cursos, índice, estado, helpers,
assets de marca, conquistas, voz, construtor de exercícios, sessão, telas e render.

## Licença

A marca Linguae, o Leon e o material dos kits são do autor do projeto e não estão
cobertos por licença aberta.
