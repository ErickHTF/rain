# Revisão visual — redesign mobile-first

Em 390 px, a página de resultado passou de **2957 px para 1962 px (−33,6%)**, nos temas claro e escuro, com fontes e Leaflet carregados. O veredito ocupa **152–367 px** do topo; cabe inteiro na primeira tela de 844 px. O formulário está recolhido na nova versão. Ambas usam detalhes fechados e previsão controlada de chuva forte.

| Tema | Antes | Depois | Redução |
| --- | ---: | ---: | ---: |
| Claro | 2957 px | 1962 px | 33,6% |
| Escuro | 2957 px | 1962 px | 33,6% |

Compare [antes claro](baseline/after-mobile-light.png) com [depois claro](after-mobile-light.png), e [antes escuro](baseline/after-mobile-dark.png) com [depois escuro](after-mobile-dark.png). A pasta `baseline/` preserva os seis resultados que existiam antes desta tarefa; `before-*` na raiz são capturas de uma revisão ainda anterior.

Na execução sem serviços de apresentação externos, sob as mesmas condições antes/depois, a altura passou de **2765 para 1746 px (−36,9%)** em ambos os temas. Essas referências estão em `baseline/offline/` e `offline/`. Os JSONs `measurements-live.json` e `measurements-offline.json` registram altura e posição do veredito por viewport/tema.

## O que mudou

- CSS parte de uma coluna móvel, com duas colunas a partir de 1024 px. Somente consultas `min-width` para largura.
- Tipografia: 14 / 16 / 20 / 28 / 36 px; créditos e atribuição do mapa usam 12 px. Espaçamento: 4 / 8 / 12 / 16 / 24 / 32 / 48 px.
- Resultado móvel abre com resumo expansível da viagem e veredito; o resumo acompanha o horário selecionado, mantém nomes completos no nome acessível e devolve o formulário para edição.
- Metadados foram para os detalhes; a alternativa de saída fica junto à comparação. Trechos em lista vertical abaixo de 768 px. Sem rótulo “Comparar” repetido nos cartões.
- Cópia redundante removida. O tom secundário claro passou de `#62706a` para `#5d6b65`, para atingir AA também sobre o fundo lilás.
- Mantida a indicação de dia nos cartões que atravessam a meia-noite, para não confundir horários. Mantidos avisos sobre horário passado e a aproximação de moto quando aplicáveis.

## Validação

- `npm test`: 9 testes passaram.
- `npm run test:browser`: 16 passaram; captura opcional ignorada nessa execução e executada separadamente abaixo.
- Os 13 testes existentes de comportamento não foram alterados. `mobile.spec.js` adiciona três testes: resumo/edição/foco, layout/tipografia/alvos de toque e contraste dos dois temas.
- Layout sem overflow em 320, 390, 768, 1024, 1280 e 1920 px, incluindo formulário aberto e detalhes expandidos. Fontes renderizadas ≥14 px fora das exceções; alvos de toque ≥44 × 44 px.
- A captura agora reabre o formulário antes de editar, aguarda a mudança de breakpoint, rejeita erros inesperados e verifica automaticamente a redução mínima de 30% e o veredito na primeira tela.
- Inspeção de declarações com `rg`: nenhum `max-width` em media queries; os únicos `font-size` numéricos menores que 14 px são créditos e atribuição.

## Reproduzir

```sh
UI_SCREENSHOTS=1 npm run test:browser -- tests/capture.spec.js
# Fontes, Leaflet e mapa reais; exige internet:
UI_SCREENSHOTS=1 UI_LIVE_ASSETS=1 npm run test:browser -- tests/capture.spec.js
```

`initial-*`, `after-*` e `place-*` cobrem 320, 390 e 1440 px nos dois temas. Há também capturas móveis da alternativa seca, detalhes expandidos e erro com nova tentativa. As imagens finais na raiz usam fontes e mapa reais; a previsão e a rota são respostas controladas exclusivas dos testes. A disponibilidade dos tiles pode variar entre execuções.
