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
# 1. Chrome de automação com perfil isolado (não toque no seu Chrome pessoal)
chrome.exe --user-data-dir=<pasta temporária> --remote-debugging-port=9444            --no-first-run --no-default-browser-check about:blank

# 2. Carregar a extensão pelo próprio protocolo
#    Extensions.loadUnpacked { path: "<caminho absoluto de dist>" }  →  devolve o id
```

Depois disso dá para abrir `chrome-extension://<id>/index.html` como aba comum e dirigir tudo
por `Runtime.evaluate` — inclusive chamar `chrome.tabs.sendMessage` do service worker para
exercitar ações reais na página.

Ao encerrar, matar **só o processo daquela porta** (`netstat -ano` → `taskkill /PID`), nunca
`taskkill /IM chrome.exe`, que derruba o navegador pessoal junto.

## Scripts

```bash
npm run build       # build completo (é o que gera dist/)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run harness     # exercita o loop do agente em Node, sem navegador
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
