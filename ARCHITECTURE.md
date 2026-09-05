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

`chrome.debugger` está em `optional_permissions`, não em `permissions`: a instalação padrão não
exibe o aviso de depuração, e o CDP seria pedido com gesto do usuário. **A escalada em si ainda
não foi construída** — o sinal que a dispararia (`"sem efeito perceptível"` no resultado do
clique) já existe.

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

## Chaves de armazenamento

`vela:settings`, `vela:conversations`, `vela:logs`, `vela:user-scripts`, `vela:pulse-position`
em `storage.local`; `vela:session` e `vela:attachments` em `storage.session` (somem ao fechar o
Chrome, que é o desejado para id de tab group). Há migração automática das chaves antigas
`browser-ai:*`.

## Pendências conhecidas

Registradas para decisão, não esquecidas:

1. **Escalada para CDP ("Modo preciso")** — o caminho DOM está pronto e emite o sinal que a
   dispararia (`"sem efeito perceptível"`). O `chrome.debugger` já está em
   `optional_permissions`. Falta o `cdp-actuator` e o consentimento por sessão.
2. **iframes cross-origin** — `page-snapshot` percorre o documento de topo e shadow roots
   abertos; iframes de outra origem são invisíveis. É onde vivem checkout, login e captcha.
   Exige `allFrames: true` no registro **e** guardar toda a UI atrás de
   `window.top === window.self` antes, senão um site com 12 iframes de anúncio ganha 12 Lens.
3. **Seções de opções ainda vazias** — Geral, Navegador, Permissões e Atalhos mostram
   "Em preparação".
4. **Sem atalho de teclado** — o manifest não declara `commands`; abrir o painel exige clique.
5. **Aprovação com o painel fechado** só aparece se o Live Voice estiver ligado (é o Pulse que
   a mostra). Sem nenhuma das duas superfícies, a ação é recusada com `unattended`.
6. **`session:rename` não tem quem chame** — o backend existe, falta a UI de renomear a tarefa.
7. **Modo claro nunca foi verificado visualmente** — os tokens existem, o olhar não.
8. **Endpoints de áudio não confirmados** — dependem da sondagem com a chave real.
9. **Não é repositório git** — `.gitignore` pronto, `git init` não foi rodado.
