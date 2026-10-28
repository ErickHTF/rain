# Chuva no Caminho

Aplicação web em português para consultar chuva ao longo de uma rota de carro e comparar saídas durante três horas: a cada 30 minutos se todos os horários analisados estiverem secos, ou a cada 15 minutos se houver chuva. Usa JavaScript nativo, CSS e Leaflet, sem backend ou etapa de build.

## Executar localmente

Requisitos: Node.js 20 ou superior e Python 3 (servidor de desenvolvimento).

```sh
npm ci
npm run dev
```

Abra http://localhost:4173. A localização do navegador funciona em localhost ou HTTPS. Endereços são pesquisados no Brasil; coordenadas também são aceitas. Os horários usam Brasília (`America/Sao_Paulo`). Origem, destino, tema e resultados de geocodificação são salvos no armazenamento local do navegador.

A tela inicial aguarda a escolha da rota. Use **Ver chuva no caminho** para consultar; alterações no formulário ocultam a previsão anterior até uma nova consulta. **Agora** ajusta a saída, e a localização preenche a origem. Nos resultados, os 7 ou 13 horários são botões com condição, ícone e seleção explícita. Quando há uma saída posterior com menor intensidade prevista, é possível compará-la diretamente pelo resultado. As consultas repetidas continuam aproveitando o cache existente.

Para publicar, sirva `index.html`, `style.css`, `app.js`, `api.js`, `logic.js` e `radar.js` em uma hospedagem estática HTTPS. Nenhuma chave de API é necessária. Fontes e Leaflet são carregados por CDN.

## Verificação

```sh
npm test
npx playwright install chromium
npm run test:browser
```

Os testes unitários verificam interpolação, cobertura temporal, dados ausentes, erros de rede e limites do radar. Os testes de navegador usam respostas controladas, sem depender da disponibilidade dos serviços, e verificam o resultado, navegação por teclado, telas pequenas e falhas dos provedores. É possível usar um Chromium já instalado definindo `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

Para gerar capturas de revisão em `artifacts/ui/`:

```sh
UI_SCREENSHOTS=1 npm run test:browser -- tests/capture.spec.js
# Inclui Leaflet, fontes e mapas reais (exige internet):
UI_SCREENSHOTS=1 UI_LIVE_ASSETS=1 npm run test:browser -- tests/capture.spec.js
```

As capturas de revisão usam previsão controlada exclusivamente nos testes. A interface de produção usa somente os serviços reais. A revisão cobre temas claro e escuro, larguras de 320 a 1920 px, estados de consulta, erro e recuperação, foco do teclado e comparação de saídas. Os detalhes meteorológicos ficam em uma seção expansível; os trechos do mapa usam cor e traços diferentes para cada intensidade.

Para uma conferência opcional com os serviços reais (exige internet):

```sh
npm run verificar
npm run verificar -- "-23.11, -47.22" "-23.21, -47.32"
```

## Organização

- `api.js`: geocodificação, rota, previsão, timeout de requisições e cache de endereços.
- `logic.js`: pontos da rota, horários, leitura da previsão e comparação de saídas.
- `radar.js`: imagens, estimativa de deslocamento e leitura do radar.
- `app.js`: formulário, estados de consulta, resultados e mapa.
- `tests/`: testes unitários e de navegador.

## Fontes e limites

Nominatim/OpenStreetMap fornece os endereços; OSRM fornece uma rota de carro; Open-Meteo fornece a previsão; RainViewer fornece imagens de radar. Os provedores recebem as coordenadas consultadas. Requisições JSON têm limite de 15 segundos e imagens de radar, 12 segundos. Consultas de endereço são espaçadas; dados da rota e do tempo são reutilizados por até dez minutos.

A análise usa 11 pontos na rota e estima o horário de passagem proporcionalmente à distância, sem trânsito em tempo real. O radar é uma estimativa local de movimento, limitada a 50 minutos após a imagem mais recente. Imagens transparentes não permitem distinguir ausência de chuva de ausência de cobertura. Radar indisponível, pontos fora da imagem e rotas grandes demais para o processamento local usam a previsão regional. Dados meteorológicos ausentes geram erro, em vez de serem interpretados como tempo seco.

A janela de saída considera a cobertura de todos os pontos, a duração da viagem e as três horas da comparação. Horários passados podem usar dados de modelo; não representam necessariamente uma observação histórica. O mapa pode falhar independentemente da previsão, e os detalhes continuam disponíveis.


## Locais e meios de transporte

Nomes e endereços passam por uma confirmação antes da rota: até cinco resultados, endereço completo, mapa e link para conferir o ponto no Google Maps. Coordenadas exatas podem seguir diretamente, com prévia disponível em **Conferir origem/destino**. Alterar o texto invalida a confirmação; escolher outro resultado muda as coordenadas usadas na rota e no cache. A busca é feita por ação explícita e mantém o espaçamento entre requisições do Nominatim, sem autocompletar a cada tecla. Fotos e avaliações não são fabricadas.

Carro mantém o OSRM existente. Moto usa a rota e a duração de carro como aproximação, indicada no formulário e no resultado. Bicicleta e caminhada usam os perfis próprios do [FOSSGIS](https://routing.openstreetmap.de/about.html), com limite de uma requisição por segundo. Cada modo usa a geometria e a duração retornadas pelo serviço; não é aplicada uma velocidade inventada à rota de carro. Não há dados de trânsito nem perfil específico de motocicleta.

Antes de reduzir os horários exibidos para 30 minutos, o app ainda verifica todas as 13 saídas de 15 minutos. Uma ocorrência de chuva em qualquer uma delas mantém a comparação detalhada. A janela continua sendo de três horas.
