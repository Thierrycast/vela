# Testes e ferramentas de desenvolvimento

A Vela não tem test runner: o que ela tem é um **harness** que roda o loop do agente inteiro em
Node contra um provider e uma página falsos, e um **driver** que dirige um Chrome de verdade com a
extensão carregada. Os dois rodam sem chave de API.

```bash
npm run typecheck && npm run lint && npm run build && npm run harness
```

## O harness

`npm run harness` executa o loop de verdade — mesmo código do service worker — contra um provider
falso que devolve as respostas que o cenário mandar, e uma página falsa que responde como o content
script responderia. São mais de trinta cenários com invariantes explícitas: refs que sobrevivem a
releituras, lista que recicla linhas, lote que para no primeiro erro, escada de leitura, gate de
domínio, narração da voz, gravação por conversa.

É onde os erros de lógica aparecem antes de você carregar a extensão.

## Conferência manual, na extensão carregada

| Teste | O que deve acontecer |
|---|---|
| Abra uma página comum e peça *"leia esta página e liste os botões"* | Deve listar botões que existem de verdade, com refs |
| *"vá para example.com e me diga o título"* | Navega, espera o load, lê e responde |
| Troque a autonomia para **Observar** e peça um clique | Recusa, mas a seta vazada viaja até o alvo |
| Em **Assistir**, peça um clique | Aparece um cartão pedindo aprovação antes de agir |
| Selecione um texto em qualquer página | Aparece a marca da Vela; o menu oferece Perguntar/Explicar/Resumir/Usar como contexto |
| Feche e reabra o painel no meio de uma tarefa | O histórico e o estado de execução continuam |
| Peça *"busque X neste site"* numa página com campo de busca | Deve agrupar abrir/clicar/digitar/Enter num lote só, não em quatro rodadas |
| Leia a página, clique em algo, e peça para clicar em outro elemento da mesma leitura | Deve funcionar sem reler: os refs continuam válidos |
| Numa lista longa, role até reciclar as linhas e use um ref antigo | Deve recusar com `ref_changed` e dizer o que aquele item era |

## Testar a leitura de página contra uma página controlada

```bash
npm run build
node tools/drive.mjs --fixtures --roteiro=tools/fixtures/roteiro-pagina.json
```

Sobe um servidor local com `tools/fixtures/`, carrega a extensão num Chrome limpo e conversa com o
content script **sem passar pelo modelo** — o que sai é o retrato como a página o produz, não o
texto já compactado da conversa. É assim que se confere a árvore (cada botão dentro do seu item), o
`find` por papel, a espera por condição e o campo que só aceita evento confiável.

A cópia carregada no teste traz o acesso aos sites como permissão fixa: o diálogo do Chrome que
pede essa autorização no uso real não pode ser respondido por um roteiro automático. O código
exercitado é o mesmo.

### Um turno inteiro sem gastar chave de API

```bash
node tools/drive.mjs --fixtures --roteiro=tools/fixtures/roteiro-rastreio.json --saida=trilha.jsonl
```

O mesmo servidor de fixtures serve também um **modelo falso** em `/api/v1/chat/completions`: ele lê
a página na primeira rodada e conclui na segunda, sempre igual. O que se verifica não é a
inteligência da resposta — é que a trilha registrou o caminho inteiro (prompt enviado, resposta
crua, chamada de ferramenta, resultado, tokens) com o rastreio completo ligado. Sem isso, checar o
rastreio dependeria da chave de API de quem está revisando.

### A voz inteira, sem ninguém falar

```bash
node tools/drive.mjs --fixtures --audio=fala.wav --roteiro=tools/fixtures/roteiro-voz.json
node tools/drive.mjs --fixtures --audio=fala.wav --roteiro=tools/fixtures/roteiro-voz-pacote.json
```

`--audio` põe um microfone falso tocando o arquivo (WAV PCM 16 bits, mono). O caminho inteiro roda
de verdade: VAD, texto ao vivo, transcrição, turno (contra o modelo falso), síntese e reprodução,
usando o servidor de voz configurado. O primeiro roteiro confere a trilha; o segundo aperta o botão
de gravar do palco e confere o pacote de revisão baixado.

Uma fala de teste sai do próprio servidor de voz:

```bash
curl -X POST http://SERVIDOR/v1/audio/speech -H "Content-Type: application/json" \
  -d '{"input":"Abra a página de resultados.","model":"tts-1","voice":"piper:pt_BR-cadu-medium"}' -o fala.mp3
ffmpeg -i fala.mp3 -ac 1 -ar 48000 -c:a pcm_s16le -af apad=pad_dur=3 fala.wav
```

Downloads feitos durante o roteiro caem numa pasta do perfil temporário — nunca na pasta Downloads
de quem roda — e o resumo lista cada arquivo baixado.

### Medir se ficou mais rápido

```bash
node tools/drive.mjs --fixtures --roteiro=tools/fixtures/roteiro-medicao.json
```

Dez leituras, dez buscas e dez cliques numa página de ~8 mil elementos, com o tempo de cada ação ao
lado. É assim que se compara uma mudança com o estado anterior (`git stash push src`, build, rodar,
`git stash pop`) em vez de confiar na impressão de que ficou melhor.

## Testar com a extensão carregada automaticamente

`--load-extension` é ignorado silenciosamente no Chrome 137+, e `--disable-features=
DisableLoadExtensionCommandLineSwitch` **não** resolve. O caminho que funciona é o CDP:

```bash
# 1. Chrome de teste com perfil isolado, em posição VISÍVEL na tela
chrome.exe --user-data-dir=<pasta temporária> --remote-debugging-port=9451            --window-position=60,60 --window-size=1200,900            --no-first-run --no-default-browser-check about:blank

# 2. Carregar a extensão pelo próprio protocolo
#    Extensions.loadUnpacked { path: "<caminho absoluto de dist>" }  →  devolve o id
```

`Extensions.loadUnpacked` funciona tanto com janela quanto em `--headless=new`, com as APIs de
extensão completas e o service worker ativo. Depois disso dá para abrir
`chrome-extension://<id>/index.html` como aba comum e dirigir tudo por `Runtime.evaluate` —
inclusive chamar `chrome.tabs.sendMessage` a partir do service worker para exercitar ações reais
numa página.

**Nunca posicione a janela fora da tela.** `--window-position=3000,3000` deixa a instância na
barra de tarefas sem poder ser clicada, o que parece travamento. Janela de teste é para ser vista
e usada; headless só quando a medição é automatizada e não há nada para olhar.

Ao encerrar, matar **só o processo daquela porta** (`netstat -ano` → `taskkill /PID`), nunca
`taskkill /IM chrome.exe`, que derruba o navegador pessoal junto.

## Revisar a interface fora da extensão

Ferramentas de review de interface não conseguem abrir páginas `chrome-extension://`. Para isso
existe um servidor de preview que serve **a mesma UI** em localhost — mesmos componentes, mesmo
CSS, mesmos estados; só o `chrome.*` é substituído por um dublê.

```bash
npm run ui        # http://127.0.0.1:5178
```

A página inicial lista as superfícies e os estados:

| Rota | Estado |
|---|---|
| `/panel.html` | conversa em andamento, com atividade e anexo |
| `/panel.html?estado=vazio` | primeira abertura |
| `/panel.html?estado=executando` | agente trabalhando |
| `/panel.html?estado=aprovacao` | pedindo aprovação (modo Assistir) |
| `/panel.html?estado=suavez` | tomada de controle |
| `/options.html` | configurações, todas as seções |

O painel vem contido em largura de barra lateral (380 px) e **centralizado** — encostado numa
borda ele sai do recorte quando a ferramenta captura um viewport mais estreito que a janela.
Para outra largura, `?largura=440` (aceita 260 a 640). As configurações abrem em tela cheia,
que é como elas realmente aparecem.

O dublê vive em `tools/preview/chrome-stub.ts`; novos estados entram lá.
