# Arquitetura e decisões

Documento vivo. Registra **por que** as coisas são como são — o código diz o *como*.

## As cinco superfícies

O produto é desenhado em torno de cinco lugares onde a Vela aparece, cada um com um papel:

| Superfície | Onde vive | Papel |
|---|---|---|
| **Sidecar** | `main.tsx` (side panel) | Conversa, contexto, aprovações, atividade, histórico |
| **Pulse** | `pulse.ts` (shadow DOM na página) | Voz contínua e aprovações **com o painel fechado** |
| **Trace** | `trace-layer.ts` (shadow DOM) | Cursor visível, borda de controle, destaque do alvo |
| **Lens** | `content.ts` (shadow DOM) | Menu contextual na seleção de texto |
| **Session** | `session.ts` (tab group nativo) | A tarefa como grupo de abas do Chrome |

## Decisões

### O loop do agente vive no background, não no painel

`agent-loop.ts` roda no service worker. Se ele vivesse no painel, três coisas seriam
impossíveis: Live Voice com ferramentas, aprovação aparecendo no Pulse com o painel fechado, e
sobreviver ao usuário fechar a sidebar no meio de uma tarefa. O painel é **view**: conecta pela
porta `vela:sidecar`, recebe um snapshot e depois eventos.

Custo: o service worker morre com 30 s de ociosidade e uma aprovação humana demora mais que
isso. Por isso há um heartbeat de 20 s enquanto houver loop ativo (`background.ts`).

### A página é endereçada por `ref`, não por seletor CSS

`extractPage` devolve `[ref_<snapshot>_<índice>]` para cada elemento interativo, e o modelo cita
esse ref de volta. Seletor CSS tem quatro problemas que ref não tem: o modelo **inventa** o
seletor a partir de um DOM que viu parcialmente; `querySelector` pega silenciosamente o primeiro
de N; class names hasheados (Tailwind, CSS-in-JS) quebram sempre; e shadow DOM é inexpressável.

O preço do ref é ficar obsoleto quando o DOM muda — mas isso é **detectável**. Toda ação carrega
o id do snapshot; se não bater, o modelo recebe `stale_snapshot` e relê. Seletor errado é
indetectável, que é bem pior.

`selector` continua aceito como alternativa para o que não aparece no snapshot.

### Toda ação devolve o que realmente aconteceu

`ActionResult` é `{ok:true, summary, …}` ou `{ok:false, code, summary}`, com códigos como
`stale_snapshot`, `restricted_url`, `element_not_found`, `denied`, `timeout`. O `click` instala
um `MutationObserver` e compara a URL antes/depois para reportar se a página **reagiu, navegou ou
não fez nada**.

Isso existe porque a versão anterior devolvia `"Ação executada"` sempre, antes mesmo da ação
rodar. Um agente que recebe sucesso falso não tem como se corrigir — ele alucina progresso.

### Estado volátil fora do system prompt

`buildSystemPrompt` é estático (identidade, ferramentas, regras). O estado do navegador vai num
bloco `<estado_do_navegador>` como mensagem efêmera **no fim** da lista, reconstruída a cada
rodada e nunca persistida. Colocá-lo no system invalidaria o cache de prefixo do provider a cada
requisição — numa tarefa de 8 rodadas, é a diferença entre pagar o prompt inteiro 8 vezes e pagar
só o delta.

Pela mesma economia, `compactSnapshots()` substitui retratos de página antigos por um marcador:
o DOM já mudou e o modelo não deve consultá-los.

### DOM aprimorado primeiro; CDP é escalada, não padrão

O caminho DOM faz a sequência pointer completa (`pointerover → pointerdown → mousedown → focus →
pointerup → mouseup → click`), digita caractere a caractere usando o **setter nativo de `value`**
— sem ele o React sobrescreve o valor no próximo render — e trata `Enter` com fallback para
`form.requestSubmit()`.

Isso cobre muito mais do que parece: um `click()` não-confiável **executa** a activation behavior
(submete formulário, marca checkbox, navega em `<a>`). O que evento não-confiável nunca faz é
ação padrão de **teclado** — daí os fallbacks.

**`debugger` não pode ser opcional.** O Chrome recusa: *"Permission 'debugger' cannot be listed as
optional. This permission will be omitted."* Ou seja, não existe pedir CDP sob demanda com gesto
do usuário — ou a permissão está em `permissions` desde a instalação, com o aviso de depuração no
diálogo, ou não existe.

Hoje ela **não** está declarada: a extensão instala sem aviso assustador e o caminho DOM cobre o
uso. **A escalada em si não foi construída** — o sinal que a dispararia (`"sem efeito perceptível"`
no resultado do clique) já existe. Quando for construída, a decisão passa a ser do usuário no
momento da instalação, não no momento do uso.

### Aprovação mora no background

`approvals.ts` é consultado dentro de `executeAction`, não na UI. Se o gate estivesse no painel,
Live Voice, Lens e Pulse o contornariam, e fechar a sidebar desligaria a proteção.

Três resultados, não dois: `allow`, `deny` e **`unattended`** — não havia nenhuma superfície
aberta para perguntar. O modelo precisa distinguir "você recusou" de "não havia quem
aprovasse", senão insiste na mesma chamada.

Ações irreversíveis (`/comprar|pagar|excluir|confirmar|transferir/`) pedem confirmação **mesmo em
modo Auto**.

### Campos sensíveis são redigidos na leitura

`page-snapshot.ts` nunca expõe o valor de `type=password|hidden` nem de campos com `autocomplete`
de senha, OTP ou cartão — eles chegam ao modelo como `[valor omitido]`. É filtro na origem, não
instrução no prompt: o modelo não pode vazar o que nunca recebeu.

### Voz: PCM + VAD, não MediaRecorder

`MediaRecorder` emite o *initialization segment* do WebM só no primeiro chunk — chunks seguintes
não são contêineres válidos isolados, e servidores Whisper os rejeitam. Era a causa do Live Voice
degradar depois dos primeiros segundos.

O runtime captura PCM por AudioWorklet e `vad.ts` segmenta **por silêncio**: início quando a fala
sustenta ~130 ms, fim quando o silêncio sustenta ~700 ms, com *pre-roll* de 300 ms para o ataque
da primeira palavra não ser cortado. Cada enunciado vira um WAV completo. O pre-roll é impossível
com MediaRecorder sem quebrar o contêiner — foi o que decidiu a troca.

### Content script sob demanda, e em build separado

O manifest **não** declara `content_scripts`. `injection.ts` registra em runtime via
`chrome.scripting.registerContentScripts`, condicionado ao contexto de seleção estar ligado; para
agir, o agente injeta na hora.

O content script é buildado por `vite.content.config.ts` **separado**, com
`inlineDynamicImports` e formato IIFE. Motivo: scripts injetados por `files` são clássicos e não
suportam `import`. Com uma entrada só no build principal, o Rollup extrairia um chunk
compartilhado no primeiro módulo em comum e o content script quebraria **em silêncio**.

## Fluxo de uma tarefa

```
painel → chat:submit ──► agent-loop (background)
                          │
                          ├─ collectBrowserContext + buildSystemPrompt
                          ├─ streamChat ──► OmniRoute
                          ├─ tool_call ──► tool-runner ──► executeAction
                          │                                 ├─ gate de autonomia
                          │                                 ├─ beginTrace (cursor visível)
                          │                                 └─ tabs.sendMessage ──► page-actions
                          └─ eventos ──► painel + Pulse
```

## Armadilhas MV3 que este código trata

- Service worker morre com 30 s ocioso → heartbeat enquanto houver loop.
- `tabs.sendMessage` **não tem timeout** e só rejeita quando não há receptor → `Promise.race`
  com timeout por tipo de ação.
- Reinjetar o content script duplicaria listeners → guarda `window.__velaLoaded`.
- `onCompleted` não garante content script pronto → ping com retry e reinjeção.
- Navegação SPA não dispara `onCompleted`, só `onHistoryStateUpdated` → ambos escutados.
- Listeners de `webNavigation` vazam no SW → removidos no `finally`.
- Chrome não aceita SVG em ícone de extensão nem em `notifications.create` → PNGs gerados por
  `tools/forge-icons.html`.
- `getUserMedia` no offscreen não consegue exibir prompt → permissão concedida pelas opções.
- AudioWorklet precisa ser script clássico → fica em `public/`, fora do processamento do Vite.

## Movimento e fechamento de camadas

Popover e menu do Lens fecham ao clicar fora e no Escape. O do Lens usa `composedPath()` porque
vive em shadow DOM — `contains()` não atravessa a fronteira. Clicar num item do menu fecha, como
esperado; clicar em área vazia do próprio menu não.

As animações usam os tokens de `motion.css` e são de entrada, nunca de saída: mensagem e itens de
atividade sobem 6 px, cartões de aprovação e o popover fazem um *pop* curto de 4 px. Botões têm
`transform: scale(.94)` no `:active` — resposta tátil que custa nada. Tudo desligado sob
`prefers-reduced-motion`.

## Renomeação do produto e dados salvos

Trocar o nome no default não bastava: quem já usava a versão anterior tinha `appName` e
`accentColor` salvos, e o valor salvo vence o default para sempre. `healLegacyBrand()` roda uma
única vez e corrige apenas valores que sabidamente vieram da identidade antiga — nome exatamente
igual a "Browser AI" e os accents legados. Nome ou cor que o usuário escolheu de fato não são
tocados.

## Saber se está funcionando

As configurações salvam sozinhas, mas autosave não dá certeza — e para uma chave de API a certeza
é o que importa. Em vez de um botão "Salvar" (que só confirmaria a escrita local), a tela de
Providers tem **Testar**: uma requisição real ao gateway responde de uma vez se a chave foi salva,
se o gateway responde e se a credencial vale.

O resultado vira um LED ao lado do nome do provider — cinza sem chave, âmbar pulsando enquanto
testa, verde conectado com a contagem de modelos, vermelho com o motivo da falha. O teste roda
sozinho ao abrir a seção quando há chave, e a impressão digital `id:baseUrl:final-da-chave` evita
repetir a requisição a cada render.

Na sondagem de endpoints, **HTTP 400 e 422 significam que a rota existe** — ela recusou o corpo
vazio da sonda, não a requisição. Só 404 e 405 significam ausência.

## Chaves de armazenamento

`vela:settings`, `vela:conversations`, `vela:logs`, `vela:user-scripts`, `vela:pulse-position`
em `storage.local`; `vela:session` e `vela:attachments` em `storage.session` (somem ao fechar o
Chrome, que é o desejado para id de tab group). Há migração automática das chaves antigas
`browser-ai:*`.

### Leitura de iframes

`injection.ts` registra o content script com `allFrames: true` e `agent.ts` lê cada frame
separadamente, prefixando os refs com `f<frameId>.` — sem isso o `ref_1_0` do topo colidiria com
o `ref_1_0` de um iframe. Ao agir, o prefixo é removido e a mensagem roteada para aquele frame.

A UI (Lens, Pulse, Trace) fica guardada atrás de `window.top === window.self`: sem isso um site
com 12 iframes de anúncio ganharia 12 botões da Vela.

## Scripts do usuário no formato do Tampermonkey

Um script é **só código**. Nome, descrição, versão, autor e alvos vivem no bloco
`==UserScript==` dentro do próprio arquivo, lido por `user-script.ts` — o mesmo formato do
Tampermonkey e do Greasemonkey. A alternativa (guardar `name`/`matches` em campos separados do
registro) dessincroniza na primeira edição: a IA escreve um cabeçalho, o campo continua com o
nome velho, e a vitrine passa a mentir. `script-store.ts` migra os registros do formato antigo
recompondo o cabeçalho a partir dos campos soltos.

A vitrine (`scripts-panel.tsx`) é uma grade de cartões; clicar abre o editor em tela cheia com
numeração de linha, Tab que indenta e autosave de 500 ms. `script_write` e `script_list` deixam
o modelo criar e reescrever esses mesmos textos — mas **um script salvo nasce desativado** e a
Vela nunca o executa: quem clica em Executar é o usuário. `background.ts` ainda confere o
`@match` contra a URL da aba antes de rodar.

## Ponte MCP: HTTP com long-polling, não WebSocket

A Onda 7 expõe a Vela como servidor MCP para agentes de fora. Uma extensão não pode ser servidor
MCP sozinha — não abre socket nem tem stdio — então existe um processo companheiro,
`bridge/vela-bridge.mjs`, que é servidor MCP por stdio para o agente e servidor HTTP em
`127.0.0.1` para a extensão.

O plano original previa WebSocket. Dois fatos mudaram a escolha:

- O CSP da extensão libera `connect-src http://127.0.0.1:*`, mas **não** `ws://`. WebSocket
  exigiria mexer no CSP.
- Node não traz servidor WebSocket, só cliente. Seria a dependência `ws` num processo que hoje
  não tem nenhuma — ou 80 linhas de framing e handshake escritos à mão.

Long-polling resolve os dois: `node:http` puro, CSP intacto. A extensão é sempre quem inicia a
conexão; um `POST /poll` fica pendurado até 25 s esperando comando.

**A latência não vem do ciclo de 25 s.** Quando um comando termina, `bridge.ts` aborta o poll em
curso para entregar o resultado imediatamente — sem isso, um clique de 200 ms só chegaria ao
agente no fim do ciclo. Medido de ponta a ponta: 6 ms.

### O que impede um processo qualquer de dirigir o navegador

Token gerado pela extensão, comparado em tempo constante (`timingSafeEqual`), e escuta apenas em
`127.0.0.1`. Sem isso, um endpoint local sem autenticação daria a qualquer processo da máquina o
navegador logado do usuário — é a mesma regra que o CLAUDE.md global impõe à porta 9222 do CDP.

### O agente externo não é superfície de aprovação

`vela_act` passa pelo mesmo `runToolCall` da conversa, então o gate de autonomia continua
valendo. E o predicado de `configureApprovals` **não** conta a ponte: um agente de fora não tem
como responder ao cartão de aprovação. Em modo Assistir sem painel aberto, `requestApproval`
devolve `unattended` e a ação é recusada — o contrário seria uma porta lateral para furar o
próprio gate.

A ponte emite os eventos no feed do painel ("Agente externo agiu na página") para que o usuário
veja o que está sendo feito em nome dele.

### Sobrevivência do service worker

Um `POST` pendente segura o worker, mas 30 s ociosos ainda o matam entre ciclos. `chrome.alarms`
de 1 minuto acorda e reata (permissão `alarms` no manifest). Queda do processo local vira recuo
progressivo até 20 s, com o estado visível em Configurações → Ponte MCP.

## Movimento por voz: o pipeline e o renderer

A cadeia é **áudio → features → suavização → parâmetros → renderer**, e cada elo é independente
do seguinte:

- `audio-metrics.ts` — FFT de 512, bandas bass/mid/high, noise gate e **envelope com attack 0.32
  e release 0.12**. Ligar volume direto em tamanho produz tremor de VU meter; é este estágio que
  dá a sensação de massa.
- `motion-tokens.ts` — os nove estados (`idle`…`complete`). É a máquina de estados que costuma
  ser terceirizada para o Rive; aqui cabe em treze linhas e não custa um runtime WASM.
- `gl-visual.ts` — um quad que cobre a tela e um fragment shader, com segundo estágio de
  suavização e recuperação de contexto perdido. Sem biblioteca 3D: não há geometria, câmera nem
  cena, então uma delas seria um runtime inteiro para desenhar um retângulo.
- `voice-visuals.ts` — os cinco visuais atrás de uma interface só (`VoiceVisual`), que o orb em
  canvas 2D já satisfazia. Trocar de estética é trocar a classe.

O prelúdio GLSL compartilhado traz ruído por hash, fBm, `domain warping` e `smooth-min` — as
quatro peças que produzem o aspecto líquido sem simulação de fluido.

### Onde cada um pode rodar

O Pulse vive **dentro da página do usuário**: shader ali gasta a GPU do site que ele está usando.
Por isso o `AmbientEdgeVisual` é canvas 2D de propósito — é uma faixa fina numa moldura, e um
contexto WebGL sairia caro pelo que se vê. Shader fica para o painel, onde o custo é nosso.

`ShaderVisual.ok` diz se o programa compilou, para o chamador cair no renderer 2D em vez de
mostrar um retângulo vazio; `webglcontextlost` é tratado e o contexto se refaz sozinho.

### A borda viva

`AmbientEdge` acende a moldura do painel conforme o estado do agente. Sem microfone aberto a
energia é zero, então **o estado sozinho já acende** e a energia é o que faz a luz respirar —
sem isso a borda apagaria justamente enquanto o agente trabalha. Ela some no ocioso: uma barra
lateral fica aberta o dia inteiro, e luz constante viraria ruído.

## Opções → Avançado

Além do diagnóstico de ações, a seção reúne o que só faz sentido quando algo dá errado ou muda
de máquina: teto de etapas por tarefa (`agent.maxRounds`, lido pelo `agent-loop`), o espaço
ocupado por categoria com botão de limpeza por fatia, e backup/restauração em JSON
(`maintenance.ts`).

Duas decisões de segurança nesse fluxo: a chave de API **fica fora do backup por padrão** — um
JSON na pasta de downloads não é lugar de credencial — e restaurar um arquivo sem chave **não
apaga** a que já está configurada, senão importar um backup limparia o acesso sem avisar.
"Restaurar padrões" também preserva os providers.

## Medir antes de decidir sobre o CDP

`action-stats.ts` conta o desfecho real de cada ação: total, quantas saíram **sem efeito
perceptível**, e as falhas por código. A conta aparece em Opções → Avançado.

Existe por um motivo específico: a recomendação de "rode um tempo e veja se precisa de CDP" não
vale nada sem o número. Se a fatia de "sem efeito perceptível" for baixa, o caminho DOM basta e a
extensão continua instalando sem aviso de depuração. Se for alta, o `cdp-actuator` se justifica —
e aí a permissão `debugger` entra no manifest sabendo o que compra.

## Pendências conhecidas

Registradas para decisão, não esquecidas:

1. **Escalada para CDP ("Modo preciso")** — o caminho DOM está pronto e emite o sinal que a
   dispararia (`"sem efeito perceptível"`). O `chrome.debugger` já está em
   `permissions` do manifest — e isso é uma decisão de instalação, não de sessão, porque o Chrome
   não aceita `debugger` como permissão opcional.
2. ~~**Sem atalho de teclado**~~ — resolvido: `Alt+V`, alterável em `chrome://extensions/shortcuts`.
3. **Aprovação com o painel fechado** só aparece se o Live Voice estiver ligado (é o Pulse que
   a mostra). Sem nenhuma das duas superfícies, a ação é recusada com `unattended`.
4. ~~**Renomear a tarefa**~~ — resolvido: o título na topbar é editável.
5. ~~**Modo claro nunca foi verificado visualmente**~~ — resolvido: conferido no preview e na
   extensão real.
8. **A ponte MCP não tem descoberta automática de porta** — se 8792 estiver ocupada, o processo
   avisa e sai, e a porta precisa ser trocada nos dois lados à mão.
6. ~~**Endpoints de áudio não confirmados** — dependem da sondagem com a chave real.
7. ~~**Não é repositório git**~~ — resolvido: repositório iniciado, `refs/` fora do versionamento.

### O cursor é o caminho da execução, não um enfeite

`traceLayer.begin()` devolve uma **promise que resolve na chegada do cursor**, e a ação só
dispara depois dela. Antes, o cursor animava em paralelo enquanto o clique já tinha acontecido —
o desenho representava a ação em vez de ser a ação.

A decisão continua barata e instantânea: o alvo vem do retrato de DOM que já está em mãos, sem
procura. O que passa a custar tempo é só o trajeto, e ele tem teto: 450 ms em Natural, 220 ms em
Rápido, zero em Instantâneo (`settings.agent.cursorSpeed`). Só ações com alvo esperam —
`extractPage`, `web_search`, `web_fetch` e `navigate` não têm cursor e não esperam nada.

Medido na extensão real: Natural acrescenta ~520 ms por ação com alvo, Rápido ~300 ms. Uma ida
ao modelo custa segundos, então o cursor não é o gargalo.

Duas armadilhas que isso criou e que estão tratadas: o prazo precisa de um `setTimeout` de
segurança (se o loop de animação não estiver rodando, o RAF nunca cobraria o prazo e a ação
esperaria para sempre), e `end()` de uma ação não pode parar o loop enquanto outra ainda espera
chegada.

## WebMCP — verificado no Chrome 152 (set/2026)

Testado no navegador instalado, não em documentação:

- `document.modelContext` existe atrás de `--enable-features=WebMCP`. **Não** está ligado por
  padrão no estável. `navigator.modelContext` foi descontinuado; a API mora em `document`.
- Interface `ModelContext` com `registerTool`, `getTools`, `executeTool` e `ontoolchange`.
- **O mundo isolado do content script enxerga as tools registradas pela página.** Testado com
  `Page.createIsolatedWorld`: o mundo isolado leu as tools registradas no mundo principal.
  Isso significa que a Vela lê e executa tools de WebMCP **direto do content script**, sem
  injeção no mundo principal e sem ponte de postMessage.
- Só funciona em HTTPS.
- **Assinatura real de `executeTool`**, descoberta testando: recebe o *objeto* vindo de
  `getTools()` (não o nome) e os argumentos como **string JSON**. Passar um objeto falha com
  `Failed to parse input arguments`, e passar o nome falha com `not of type 'RegisteredTool'`.
- O retorno também chega como **string JSON** no formato MCP `{content:[{type,text}]}`, não como
  objeto — precisa de parse antes de extrair o texto.

Consequência de projeto: quando a página oferece uma tool (`buscar_produto`, `adicionar_ao_carrinho`),
usá-la é sempre melhor que simular cliques — é semântica, não imitação. A camada de DOM continua
necessária para tudo que não expõe tools, que hoje é quase toda a web.
