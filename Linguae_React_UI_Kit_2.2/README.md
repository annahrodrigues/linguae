# Linguae React UI Kit 2.0

Conversão do protótipo HTML/CSS/JS Linguae UI Kit 1.0 para **React + Vite**, mantendo a identidade do Brand Book 1.0.

## Como executar

Requisitos: Node.js 18+ e npm.

```bash
npm install
npm run dev
```

Abra o endereço local exibido pelo Vite. Para gerar o build: `npm run build`; para visualizar: `npm run preview`.

## Estrutura

- `src/components/UI.jsx`: Button, Card, Progress, TextField, PageHead e Stat reutilizáveis.
- `src/components/Layout.jsx`: layout, menu lateral e navegação mobile.
- `src/pages/`: Dashboard, Components, Exercise e Achievements.
- `src/styles.css`: CSS visual do protótipo original.
- `src/react.css`: ajustes React, navegação mobile, foco e movimento reduzido.
- `public/assets/`: imagens do mascote do protótipo original.

## Observações

- Interface em português, dados fictícios, sem autenticação, backend ou persistência.
- Exercícios possuem seleção, validação, feedback e fluxo entre questões.
- O Brand Book prevê um monograma L com olho para o logo definitivo; o marcador atual é provisório, como no protótipo original.
- Outfit e DM Sans são carregadas do Google Fonts e requerem conexão para aparecer corretamente.
- O código mantém o CSS existente para fidelidade visual e permite refatoração gradual.


## Atualização 2.1 — identidade visual
- `src/components/LinguaeLogo.jsx`: componente React reutilizável para a marca.
- `public/assets/linguae-logo-symbol.png`: recorte transparente do rosto do mascote aprovado.
- `public/assets/linguae-app-icon.png`: ícone de aplicativo.
- `public/favicon.png`: favicon.
- Sidebar desktop e cabeçalho mobile agora exibem a marca, substituindo o placeholder.

**Observação:** estes arquivos são PNGs rasterizados derivados da ilustração aprovada. O monograma vetorial camaleão-L descrito no Brand Book ainda requer desenho final próprio; não são SVGs vetoriais.


## 2.2 — Identidade vetorial Hidden Chameleon L
- `public/assets/linguae-monogram.svg`: símbolo vetorial, letra L com camaleão sutil e olho visível.
- `public/assets/linguae-horizontal.svg` e `linguae-vertical.svg`: assinaturas da marca.
- `public/assets/linguae-monochrome.svg`: assinatura de cor única.
- `public/assets/linguae-symbol-{16,32,64,128,256,512}.png`: exports raster.
- `public/favicon.svg` e `public/favicon.png`: favicons.
- `public/assets/linguae-app-icon.svg` e `.png`: ícone para app.
- `src/components/LinguaeLogo.jsx`: componente atualizado para usar SVG.

**Nota:** wordmarks SVG usam fonte Outfit por referência; para reprodução idêntica fora do projeto, instale Outfit ou converta texto em curvas em editor vetorial. O símbolo é vetor nativo.
