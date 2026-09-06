# Vela

Agente de navegador para Chrome (MV3): lê a página que você está vendo, navega, clica e digita
por você, e mostra o que está fazendo através de um cursor visível. Usa o **OmniRoute** como
provider de IA.

## Rodar

```bash
npm install
npm run build      # tsc -b + build principal + build separado do content script
```

Depois, em `chrome://extensions`:

1. Ligue **Modo do desenvolvedor** (canto superior direito).
2. **Carregar sem compactação** → selecione a pasta `dist/`.
3. Fixe a Vela na barra e clique no ícone para abrir o painel lateral.

Toda vez que rodar `npm run build`, clique em **Atualizar** no card da extensão.

## Primeiro uso — na ordem

1. **Opções → Providers** — cole a chave de API do OmniRoute e clique em **Modelos** para
   carregar a lista. Escolha um modelo com suporte a *tools*; sem isso a Vela só conversa.
2. **Opções → Providers → Diagnóstico** — clique em **Sondar endpoints**. Isso descobre o que o
   seu gateway realmente expõe e liga as capacidades correspondentes:
   - `web/fetch` disponível → a tool `web_fetch` passa a ser oferecida ao modelo;
   - `audio/transcriptions` disponível → os botões de voz saem do estado desabilitado.

   O código dos status importa: **404/405 = a rota não existe**; **401/403 = existe, é
   credencial**; **400/422 = existe, é o formato do corpo**.
3. **Voz (opcional)** — a permissão de microfone precisa ser concedida **a partir da página de
   opções**, porque um documento offscreen não consegue exibir o prompt do Chrome.

## Testar se está funcionando

| Teste | O que deve acontecer |
|---|---|
| Abra uma página comum e peça *"leia esta página e liste os botões"* | Deve listar botões que existem de verdade, com refs |
| *"vá para example.com e me diga o título"* | Navega, espera o load, lê e responde |
| Troque a autonomia para **Observar** e peça um clique | Recusa, mas o cursor tracejado viaja até o alvo |
| Em **Assistir**, peça um clique | Aparece um cartão pedindo aprovação antes de agir |
| Selecione um texto em qualquer página | Aparece a marca da Vela; o menu oferece Perguntar/Explicar/Resumir/Usar como contexto |
| Feche e reabra o painel no meio de uma tarefa | O histórico e o estado de execução continuam |

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

## Scripts do usuário

Em Configurações → Scripts fica a vitrine dos userscripts deste perfil. Cada cartão mostra nome,
descrição, alvos e versão; clicar abre o editor em tela cheia, que salva sozinho enquanto você
digita. O formato é o do Tampermonkey — o bloco `==UserScript==` no topo do código é quem define
`@name`, `@description`, `@match` e `@run-at`.

A Vela cria e reescreve esses scripts a pedido (`script_write`), mas **nunca os executa**: um
script salvo nasce desativado, e rodar é sempre um clique seu em Executar na aba atual.

## Ponte MCP: outros agentes usando a Vela

Configurações → Ponte MCP expõe a Vela como servidor MCP. Codex, Claude Code e afins passam a
poder ler a página aberta, agir nela, buscar na web e **delegar uma tarefa inteira** ao modelo
que você configurou aqui, com o seu Chrome logado como contexto.

A tela gera o token, monta o trecho de configuração pronto para colar e mostra o estado da
conexão. Os detalhes — ferramentas expostas, formato dos refs e as garantias de segurança —
estão em [bridge/README.md](bridge/README.md).

```bash
npm run bridge -- --token=... # só para depurar; o normal é o agente subir o processo
```

O modo de autonomia vale igual para o agente de fora: em Observar ele só lê, e em Assistir cada
ação espera aprovação no painel — sem painel aberto, a ação é recusada.

## Backup das configurações

Configurações → Avançado exporta preferências, providers e scripts num JSON. **A chave de API
fica de fora por padrão** — ligue "Incluir as chaves" só se for guardar o arquivo como se fosse
uma senha. Restaurar um backup sem chave não apaga a que já está configurada na máquina.

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

## Voice Motion Lab

```bash
npm run ui   # depois abra http://127.0.0.1:5178/lab.html
```

Os cinco visuais de voz lado a lado, **recebendo exatamente o mesmo sinal ao mesmo tempo**,
alimentados pelo seu microfone de verdade. Existe para escolher a estética falando, em vez de
comparar screenshot — que é onde a decisão sempre travava.

| | Visual | Técnica |
|---|---|---|
| 01 | Ambient Edge | canvas 2D · gradiente radial + blend aditivo |
| 02 | Mesh Field | shader · focos gaussianos + domain warping |
| 03 | Soft Orb | shader · SDF de círculo + fBm na borda |
| 04 | Liquid Blob | shader · metaballs + smooth-min + domain warping |
| 05 | Energy Field | shader · fBm em cristas + domain warping |
| 00 | Orb atual | o que está no produto hoje, para comparação honesta |

A barra de cima troca a fonte do sinal (microfone, voz simulada ou parado) e o estado do agente,
e mostra `energy / bass / mid / high` ao vivo. "Isolar" abre um visual em tela maior.

A **voz simulada** produz rajadas com pausa: serve para conferir attack e release sem falar, e
para rodar onde não há microfone.

## Scripts

```bash
npm run build       # build completo (é o que gera dist/)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run harness     # exercita o loop do agente em Node, sem navegador
npm run ui          # serve a UI em localhost para review de interface
```

O `harness` roda o loop de verdade contra um provider e uma página falsos. É onde os erros de
lógica aparecem antes de você carregar a extensão.

## Estrutura

- `src/` — código. Ver [ARCHITECTURE.md](ARCHITECTURE.md) para o desenho e as decisões.
- `public/` — manifest, ícones, fonte e o AudioWorklet (copiados sem processamento).
- `tools/` — utilitários de desenvolvimento fora do build (gerador de ícones, harness).
- `refs/` — material de referência: o brief original e extensões de terceiros descompiladas,
  usadas só para estudar arquitetura. Fora do controle de versão.

## Limitações conhecidas

- A Vela não age em `chrome://`, na Chrome Web Store nem em PDFs. Nessas páginas ela avisa o
  modelo com um erro explícito em vez de fingir sucesso.
- Sites que exigem evento de entrada confiável (upload, canvas, alguns formulários) podem não
  responder ao caminho DOM. A escalada para CDP está prevista e ainda não construída — ver
  ARCHITECTURE.md.
- Em modo **Assistir** com o painel fechado e sem Live Voice ativo, não há onde pedir aprovação:
  a ação é recusada e o modelo é informado disso.
