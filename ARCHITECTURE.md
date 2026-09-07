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

### Repetir não é insistir: a terceira chamada idêntica não roda

Um teste real no YouTube registrou sete `extractPage` seguidos até estourar o teto, quatro vezes
seguidas. O aviso de repetição existia, mas chegava como **texto** numa conversa em que o modelo
já estava decidido — e texto não impede a próxima chamada.

Agora a terceira chamada com a mesma ferramenta e os mesmos argumentos **não é executada**: volta
como `ERRO [repeticao]` dizendo o que fazer no lugar (procurar com `find`, ou explicar ao usuário
o que trava). A recusa ocupa a mesma posição da resposta da ferramenta, então o modelo lê no fluxo
normal em vez de precisar mudar de ideia por conta própria.

### O aviso de limite nunca entra no histórico do modelo

O teto de rodadas existe para o loop não rodar para sempre. Mas a mensagem *"Atingi o limite de
8 etapas"* era gravada como mensagem **do assistente** — ou seja, entrava no histórico enviado ao
modelo na rodada seguinte. O modelo lia a própria desistência como exemplo e passava a
repeti-la, às vezes antes mesmo de chegar ao teto. Um limite que se ensina.

Agora ele tem três partes separadas:

- na **penúltima** rodada, um `role: "system"` avisa que aquela é a última chance de agir e pede
  a resposta final — o modelo fecha a tarefa em vez de ser cortado no meio;
- ao estourar, o aviso sai como **evento de UI**, visível para a pessoa e invisível para o
  modelo, dizendo que basta pedir "continue";
- **repetição é detectada**: a mesma ferramenta com os mesmos argumentos três vezes injeta um
  aviso de sistema, porque estourar o teto girando em falso é o modo de falha comum, não fazer
  oito coisas diferentes.

O teto padrão subiu para 12: com o loop de repetição resolvido, oito cortava tarefa legítima.

### A página é endereçada por `ref`, não por seletor CSS

`extractPage` devolve `[ref_<snapshot>_<índice>]` para cada elemento interativo, e o modelo cita
esse ref de volta. Seletor CSS tem quatro problemas que ref não tem: o modelo **inventa** o
seletor a partir de um DOM que viu parcialmente; `querySelector` pega silenciosamente o primeiro
de N; class names hasheados (Tailwind, CSS-in-JS) quebram sempre; e shadow DOM é inexpressável.

O preço do ref é ficar obsoleto quando o DOM muda — mas isso é **detectável**. Toda ação carrega
o id do snapshot; se não bater, o modelo recebe `stale_snapshot` e relê. Seletor errado é
indetectável, que é bem pior.

`selector` continua aceito como alternativa para o que não aparece no snapshot.

### Procurar não é rolar

O retrato tem teto de 150 elementos. Numa página real com um menu de 180 links, o menu consumia
a cota **inteira** antes de o conteúdo começar — e a agente entrava no único loop que lhe restava:
rolar, reler, rolar, reler, sem nunca ver o que o usuário estava apontando na tela.

Duas mudanças:

- o corte agora acontece **depois** da ordenação por viewport, não durante a coleta na ordem do
  documento, e o retrato diz quantos elementos ficaram de fora;
- existe `find`, que varre o documento inteiro — inclusive o que está fora da tela e dentro de
  shadow DOM — casando por nome acessível, texto e atributos, sem acento e sem caixa. Devolve
  refs prontos e prefere o elemento **mais específico**: se um link e o `<div>` que o contém
  casam, o link é a resposta, porque clicar no contêiner acerta o alvo errado.

Medido numa página com 180 links de menu e uma lista de contribuições abaixo: o retrato não
continha a palavra procurada; `find` devolveu o item certo em uma chamada, e o clique no ref
funcionou.

### A captura é a exceção, não a leitura padrão

Até aqui a Vela era cega por completo: o contexto era texto, e o que existisse só em pixel —
legenda dentro de miniatura, gráfico, imagem sem `alt` — simplesmente não chegava. `screenshot`
resolve esse resto, com três limites deliberados:

- **não é a primeira leitura.** O retrato custa menos e é ele que traz os refs; a captura diz o
  que a página parece, não o que dá para clicar. O prompt diz isso explicitamente, senão a
  imagem vira o caminho preguiçoso para tudo.
- **só a mais recente sobrevive.** Toda captura nova apaga a anterior do histórico. Duas telas
  quase idênticas dobram o custo sem dizer nada a mais, e a antiga ainda mente, porque a página
  já rolou desde então.
- **nenhuma é persistida.** `chrome.storage.local` tem 10 MB; uma tela em base64 come isso
  sozinha. Ao reabrir a conversa, a imagem não volta — e não deveria.

Duas armadilhas do ambiente: `fetch` de uma `data:` URL é barrado pelo `connect-src` do manifest,
então o base64 vira bytes na mão antes do `createImageBitmap`; e a redução para 1200 px de
largura (268 KB → 156 KB, medido) roda no service worker por `OffscreenCanvas`, com o original
como reserva se qualquer etapa falhar — reduzir é otimização, e otimização não pode custar a
captura.

OCR local ficou de fora: exigiria um pacote de vários megabytes para fazer pior do que um modelo
com visão já faz com a mesma imagem.

### As abas da sessão são dela; as outras são do usuário

`tab_manage` lista, foca e fecha abas — **só as do grupo "Vela"**. Um id de fora é recusado com
mensagem, não ignorado: recusa silenciosa ensina o modelo a tentar de novo, e fechar a aba errada
não tem desfazer.

### Ela mexe nas próprias configurações, dentro de uma lista branca

"Troque para a voz do Cadu" morria em "abra Configurações → Voz" — pior ainda pela voz, que é
onde o pedido nasce. `vela_settings` lê e escreve voz, visual, cursor, moldura, tema e teto de
etapas.

Fora da lista ficam endereço de provider, chaves e **autonomia**. As duas primeiras porque mudá-las
desliga a Vela ou manda os dados do usuário para outro lugar; a autonomia porque é o freio que
autoriza a agente a agir, e quem afrouxa o freio não pode ser quem ele segura.

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

Ela está declarada, e a escalada existe: `cdp-actuator.ts` repete a ação por `Input.*` quando o
caminho DOM não moveu a página. Como a permissão não pode ser opcional, a decisão foi partida em
duas — o Chrome pede no momento da instalação, e o **Modo preciso** em Configurações → Agente
decide se a Vela chega a exercê-la. Nasce desligado: permissão declarada não é permissão exercida.

O gatilho é o resultado do próprio caminho DOM: clique com `"sem efeito perceptível"` ou tecla que
saiu como `"tecla despachada"` (ninguém a consumiu, nada aconteceu). Aí `agent.ts` traduz o `ref`
em coordenada de viewport (`agent:locate`, que também rola o alvo para a tela), despacha o evento
confiável e **verifica** com `agent:watch` — 700 ms de `MutationObserver` mais comparação de URL.

Três limites deliberados:

- **Só no frame de cima.** `Input.dispatchMouseEvent` fala em coordenadas da aba; o retângulo lido
  dentro de um iframe é relativo ao iframe. Somar as origens funciona até o primeiro iframe rolado
  ou transformado — melhor não escalar do que clicar no lugar errado.
- **Desanexa sempre**, no `finally`. Enquanto anexado, o Chrome mostra a faixa "a Vela está
  depurando este navegador"; ela aparece pelo instante da ação, não pela sessão inteira.
- **Nunca piora o resultado.** Se a escalada falhar, o resultado original volta intacto. Se ela
  funcionar e ainda assim nada mudar, a resposta diz isso com todas as letras — é o que faz o
  modelo parar de insistir num alvo que não faz o que ele imagina.

O modo preciso **não** entra na lista branca do `vela_settings`, pela mesma razão que a autonomia
não entra: quem decide se o depurador pode ser anexado não pode ser a própria agente.

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

### O grupo de abas se chama Vela, e adota o que ela abre

O grupo levava o título da tarefa (`Vela · pesquise notebooks…`), que ficava truncado a poucos
caracteres na barra e não identificava nada. O nome agora é só **Vela**: o papel da etiqueta é
dizer de quem são aquelas abas, e o assunto já está na conversa.

Aba aberta pelo próprio agente precisa de `adoptTab` explícito. `chrome.tabs.create` chamado de
dentro da extensão **não dispara** `onCreatedNavigationTarget` — o ouvinte que recolhe as abas
que a página abre sozinha não vê essa; sem a adoção, a guia nova nascia fora do grupo e a tarefa
se espalhava pela barra.

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

### Cada estado tem cor, ritmo e gesto

`STATE_MOOD` e `STATE_CHARACTER` em `gl-visual.ts` são a fonte única. Três regras que custaram
revisão para aparecer:

- **Volume nunca mexe no tempo.** Havia `uTime * (base + uEnergy * k)` em todo shader, e falar
  mais alto virava fast-forward. Energia é amplitude; a cadência vem de `pace`, que o estado
  define.
- **Volume adensa, não clareia.** Energia entrava somando luz e lavava a cor até quase branco.
  Agora escurece e satura o núcleo, e o brilho fica só na borda — força se lê por densidade e
  contraste.
- **Nada de `sin(uTime)` como oscilador.** É periódico, e o olho acha o loop por mais camadas
  que se somem. `drift` e `wander` somam ruído em escalas incomensuráveis entre si.

Além de cor e ritmo, cada estado tem um **gesto**: `waveIn` (ondas para o centro, absorvendo),
`waveOut` (emitindo), `bands` (faixas girando por dentro) e `shatter` (fatias que se soltam).
Os pesos vêm do TypeScript para o shader não virar uma árvore de condicionais por pixel.

Ouvir e falar ficam em extremos opostos de temperatura — azul frio contra âmbar quente — porque
quem está falando é a informação mais importante da tela, e matizes vizinhos não separam isso.
O estado `acting` usa exatamente o ciano da moldura de controle: são o mesmo momento.

### O palco no painel, e a janelinha desligada

Em Live Voice, `voice-stage.tsx` põe o orb por cima da conversa e o mesmo componente serve
recolhido, encostado acima do composer: só muda a classe, então o gesto de tocar nele é uma
transição contínua e não uma troca de tela. O palco **escuta a telemetria direto do runtime**, e
não pelo estado do painel — são 20 amostras por segundo, e passá-las pelo componente pai
re-renderizaria a conversa inteira a cada uma.

O Pulse, a janelinha na página, passou a nascer desligado (`voice.showPulse`). Com o painel
aberto a presença da Vela já está ali; uma segunda superfície flutuando por cima do site que a
pessoa está lendo é intrusão. Ele continua valendo para quem trabalha com a barra lateral
fechada, e o interruptor fica em Configurações → Voz.

### Falar por cima é instrução, não ruído

Numa conversa falada não existe "aguarde a vez". Mas `submit` recusava calado quando o loop já
estava rodando, e o caminho da voz chamava "fale a última resposta" logo depois — então falar
enquanto ela trabalhava **descartava a sua frase e repetia a resposta anterior**. Você perguntava
outra coisa e ouvia de novo o que já tinha ouvido.

Agora a fala nova aborta o turno em andamento, para a síntese, espera o loop encerrar de verdade
e entra no lugar. E a resposta só é falada se o turno rendeu uma resposta **nova** — comparando o
id da última mensagem antes e depois.

### Silêncio, numa conversa falada, é lido como "não me ouviu"

Quando o turno acabava sem resposta em texto — estourou o teto de etapas, por exemplo — a Vela
simplesmente não falava. Quem está conversando por voz não vê a barra lateral: interpreta o
silêncio como falha de escuta e repete o pedido, que abre outro turno, que estoura de novo. Foi
o ciclo registrado no teste: quatro pedidos, quatro estouros, nenhum vídeo aberto.

Agora um turno sem resposta é dito em voz alta. O fim da reprodução também deixou de ser
calculado por `setTimeout`: quem avisa é o `onended` do último buffer agendado, porque o relógio
do `AudioContext` e o do `setTimeout` correm separados e a diferença aparecia como o orb
continuando âmbar depois de a fala ter terminado.

### A voz é escolhida por velocidade, não por timbre

O servidor informa a razão entre tempo de geração e duração do áudio. Acima de 1 a fala chega
sempre atrasada — o servidor perde para o relógio, e o atraso cresce com a frase. Medido:
`piper:pt_BR-cadu-medium` em **0,58×** contra `kokoro:pf_dora` em **2,04×**.

Por isso a lista vem de `/voices` (e não de `/voices/names`, que omite as vozes do piper),
ordenada da mais rápida para a mais lenta, com o número visível na opção. Quem já tinha uma voz
lenta salva é migrado uma vez só, por `healVoiceEndpoint()` — a configuração ruim tinha sido
escolhida sem esse dado à vista, e deixar como está seria manter o defeito por respeito a uma
decisão que ninguém tomou de fato.

### Um canvas aceita um contexto e nunca mais outro

Depois de `getContext("2d")`, pedir `"webgl"` no mesmo elemento devolve `null` para sempre. Isso
quebrou o Pulse de um jeito silencioso: ele criava o orb de partículas no construtor, e a troca
para o shader escolhido falhava sem erro nenhum — só continuava mostrando o renderer antigo.

A correção não foi trocar o elemento (frágil), foi **não criar renderer no construtor**: o Pulse
monta o visual uma vez, em `show()`, quando a preferência já é conhecida. Pelo mesmo motivo
existe `shadersAvailable()`, que sonda num canvas descartável — sondar no canvas real o
queimaria para o renderer 2D de reserva.

**A mesma regra derrubou o painel por outro caminho**, e a sonda não bastava. Trocar o visual nas
preferências re-executa o efeito do `VelaOrb`: o canvas já estava preso ao contexto WebGL do
visual anterior, e o renderer 2D do próximo lançava `Canvas 2D indisponível`, levando o painel
junto. O caso mais fácil de encontrar era um `visual` vazio nas settings antigas, mas qualquer
troca bastava.

Por isso o canvas do orb **deixou de ser gerenciado pelo React**: o componente é um `<span>` host
e o efeito cria o elemento, podendo descartá-lo e criar outro virgem sempre que precisar. Sonda
serve para saber se WebGL existe — não diz se aquele shader compila, e não resolve trocar de
renderer no mesmo elemento.

O custo de levar os shaders ao content script é real: `content.js` foi de 33 KB para 56 KB
(18,7 KB gzip). É o preço de o Pulse poder usar qualquer visual escolhido; a infra WebGL é o
grosso, não os shaders em si, então recortar a tabela economizaria pouco.

### Onde cada um pode rodar

O Pulse vive **dentro da página do usuário**: shader ali gasta a GPU do site que ele está usando.
Por isso o `AmbientEdgeVisual` é canvas 2D de propósito — é uma faixa fina numa moldura, e um
contexto WebGL sairia caro pelo que se vê. Shader fica para o painel, onde o custo é nosso.

`ShaderVisual.ok` diz se o programa compilou, para o chamador cair no renderer 2D em vez de
mostrar um retângulo vazio; `webglcontextlost` é tratado e o contexto se refaz sozinho.

### `flex-wrap` quebra antes de encolher

A barra de envio era `nowrap` sem rolagem: abaixo de ~400 px o botão Enviar saía da área visível
e a conversa ficava sem como ser enviada — e a barra lateral do Chrome é redimensionável, então
essa largura acontece.

Passou a quebrar linha, mas quebrar sozinho não bastou: com `flex-wrap`, um item cujo tamanho
natural não cabe vai para a linha de baixo **antes** de encolher, e era o nome do modelo que
empurrava Enviar para fora da primeira linha mesmo sobrando espaço. `flex: 1 1 0` no seletor faz
o nome ceder e o botão ficar.

Medido no painel: 380 px em uma linha só; 226 px em duas, com Enviar sempre na primeira e sem
rolagem horizontal.

### Classe de estado é do componente, não do app

`.state-speaking { box-shadow: 0 0 0 5px … }` era resíduo do orb feito em CSS puro, escrito sem
prefixo. Quando o orb virou canvas, a regra continuou pegando **qualquer** elemento com aquela
classe — o `<span>` do canvas e o chip de status ganharam cada um um quadrado luminoso em volta,
porque sombra em caixa sem `border-radius` é retângulo. Regra de estado agora nasce presa ao
componente que a define.

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

1. ~~**Escalada para CDP ("Modo preciso")**~~ — resolvida: `cdp-actuator.ts` mais o gatilho em
   `agent.ts`, ligada em Configurações → Agente.
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
