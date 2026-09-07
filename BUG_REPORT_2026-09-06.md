# Relatório de testes — Vela (2026-09-06)

Teste de fumaça forçado feito por um agente Claude Code, via CDP no Chrome pessoal do usuário (perfil `Default`, extensão já instalada em modo desenvolvedor a partir de `dist/`). Cobriu: chat de texto (injeção de conteúdo, resize, double-submit, paste gigante), painel de Configurações inteiro, e uma sessão real de Live Voice conduzida pelo próprio usuário. Achados abaixo, dos mais graves aos cosméticos.

---

## 🔴 Crítico — Live Voice entra em loop e não executa a ação pedida

**Sintoma observado pelo usuário:** pediu por voz, várias vezes seguidas ("clica nele", "abre algum vídeo aí", "faz alguma coisa aí, vai", "acessa esse primeiro vídeo aí"), para abrir/clicar um vídeo do YouTube. A Vela nunca conseguiu. Em vez disso repetiu a mesma frase de status ("Pronto, já naveguei pro YouTube") múltiplas vezes seguidas, como se não estivesse processando os pedidos novos.

**O que o log de "Atividade do agente" mostra (transcrito literalmente, 40 eventos):**

```
Iniciando Live Voice…
Abri https://www.youtube.com/. Chame extractPage para ler a página.
Página lida em 1 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Nenhum elemento casa com o seletor a[title*='9Router'].
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Parei em 8 etapas. Diga "continue" para eu seguir de onde parei.
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Parei em 8 etapas. Diga "continue" para eu seguir de onde parei.
Digitei em combobox "Pesquisar" (valor agora: "Como Usar o 9Router: IA pra Programar Infinita e DE GRAÇA"). formulário enviado
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Parei em 8 etapas. Diga "continue" para eu seguir de onde parei.
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Página lida em 2 frame(s).
Parei em 8 etapas. Diga "continue" para eu seguir de onde parei.
Live Voice encerrado.
```

**Diagnóstico:**
1. O agente fica preso chamando `extractPage` repetidamente (7-8x seguidas) sem nunca progredir para uma ação de clique real. A única tentativa de ação foi um seletor CSS genérico (`a[title*='9Router']`) que não bateu com nada na página real do YouTube, e uma única vez conseguiu digitar na busca e submeter o formulário — mas depois disso voltou a ficar preso relendo a página, sem nunca clicar em um resultado.
2. **O limite de "8 etapas" (configurável em Configurações → Permissões → "Etapas por tarefa") deveria parar a execução e aguardar o usuário dizer "continue"** — a própria mensagem do sistema diz isso. Só que isso aconteceu **4 vezes seguidas sem que o usuário tivesse dito "continue"** entre elas. No modo Live Voice, esse freio de segurança parece não travar de verdade: o agente reinicia sozinho e cai no mesmo loop de novo.
3. Resultado: nenhum vídeo foi aberto, apesar de 4 pedidos explícitos e diretos do usuário. Só terminou quando ele encerrou o Live Voice manualmente.

**Rede observada durante o loop** (via CDP, sessão armada só na extensão): múltiplas chamadas consecutivas a `POST https://SEU-GATEWAY/api/v1/chat/completions`, todas `200 OK` — ou seja, o modelo respondia normalmente a cada chamada, o problema não é de rede/backend, é de lógica de execução/orquestração do agente (ele decide chamar `extractPage` de novo em vez de agir, e ignora o próprio limite de etapas quando em Live Voice).

**Hipótese do usuário (não confirmada, mas plausível):** as ferramentas de "contexto" (o que a Vela vê da página) e de "execução" (ações que ela pode tomar) podem não estar bem encaixadas — ela lê a página mas não consegue usar o que leu para decidir uma ação de clique válida.

---

## 🟡 Sugestão de investigação — sistema de captura de contexto da página

Observação do usuário, olhando o log: parece que em algum momento a Vela manda uma **captura de tela (screenshot)** para o modelo, além de ler o HTML. Sugestão: vale estudar/aprimorar como o contexto da página é montado — hoje parece que ele varia entre HTML bruto e screenshot; talvez o ideal fosse combinar HTML (metadados, texto, descrições, atributos) **com OCR sobre a screenshot** para capturar informação que só existe visualmente (texto dentro de thumbnails de vídeo, imagens, etc.) — isso pode estar relacionado à causa raiz do loop acima, já que "ver" a página não está virando "conseguir agir" na página.

---

## 🟡 Bug de UX — indicador visual de voz dessincronizado do áudio

Observação do usuário: o orb muda de cor para indicar os estados (pensando / ouvindo / falando — ver Configurações → Voz, que documenta "azul quando você fala, âmbar quando é ela"). Só que a cor de "falando" **permanece por um tempo depois que o áudio já parou de tocar** — o indicador visual fica atrasado em relação ao áudio real. Vale investigar a sincronização entre o evento de fim de reprodução do TTS e a transição de estado do orb.

Isso pode estar relacionado a um padrão observado via rede: toda vez que o TTS tocava, `POST http://SEU-SERVIDOR-DE-VOZ:8010/tts/stream` respondia `200`, mas logo em seguida o Chrome registrava `net::ERR_ABORTED` na mesma URL (visto 3x consecutivas durante o teste). Pode ser só o stream de áudio sendo cancelado normalmente ao terminar (comportamento comum com `fetch` + `ReadableStream` + abort ao final da reprodução) — mas a consistência do padrão, junto com o atraso visual relatado, sugere que vale conferir se o cancelamento do stream está de fato alinhado com o fim real da reprodução, ou se corta/atrasa a transição de estado.

---

## 🟡 Sugestão de melhoria — paralelismo / fila de pedidos

O usuário notou que a Vela mencionou ter "um sistema de fila" — de pedidos/perguntas versus tarefas que ela coloca na fila para executar depois. Ele sugere considerar otimizar isso: dar mais clareza/capacidade de rodar coisas em paralelo (ex: responder uma pergunta rápida enquanto uma tarefa mais longa continua na fila), já que hoje não está claro pro usuário como esse sistema decide o que é "pergunta imediata" vs "tarefa para a fila".

---

## 🐞 Bugs de UI encontrados (fora do teste de voz)

### 1. Botão de modelo do chat não abre nada
O botão `auto/best-coding` na barra de composição do chat (`title="OmniRoute · auto/best-coding — clique para trocar"`) não responde a clique — nem via coordenada real nem via `.click()` direto no DOM. Sem erro no console, sem popup, sem mudança no DOM. Confirmado que o mecanismo de troca de modelo funciona (testado em Configurações → Providers → botão "Modelos", que lista os 1459 modelos certinho); o problema está isolado nesse botão específico do composer do chat.

### 2. Barra de composição quebra abaixo de ~400px de largura
`.composer-bar` usa `display:flex; flex-wrap:nowrap; overflow-x:visible`. Testado de 260px a 500px de largura de painel:
- **Abaixo de ~400px**, o conteúdo (anexar, mic, live, autonomia, modelo, enviar) transborda sem quebrar linha e sem scroll horizontal, e **o botão Enviar fica fisicamente fora da área visível/clicável**.
- Threshold exato medido: quebra em 380px, funciona normal a partir de 400px (`scrollWidth === clientWidth` só a partir daí).
- Isso é relevante porque a Vela roda no side panel do Chrome, que o usuário pode redimensionar livremente abaixo desse limiar.

---

## ✅ O que foi testado e passou bem

- Injeção de HTML/markdown no chat (`<img onerror>`, `<script>`, links `javascript:`) — renderizado como texto puro, sem execução. Sem XSS.
- Clique múltiplo/rápido em Enviar — não duplica mensagem, botão desabilita corretamente durante "Pensando".
- Paste de texto gigante (6400 caracteres) — sem travar, textarea cresce com limite e scroll interno.
- Dropdown de Autonomia (Observar/Assistir/Auto) — funciona e sincroniza corretamente entre o chat e Configurações → Agente.
- Teste de conexão do provider (OmniRoute, em Configurações → Providers) — funciona, reporta os 1459 modelos corretamente.
- Chips de ação rápida "Ler a página atual" / "Pesquisar na web" — preenchem o campo como esperado.
- Fluxo de voz ponta a ponta (transcrição): áudio → `POST SEU-SERVIDOR-DE-VOZ:8010/v1/audio/transcriptions` (Whisper local, no argos) → `200 OK` → texto transcrito segue pro `chat/completions` normalmente. A transcrição em si funciona bem.

## ⛔ Não testado (limitação da automação, não do app)

- **Anexar arquivo**: o Chrome bloqueia diálogos de seleção de arquivo nativos quando a aba é controlada via CDP em segundo plano — não confirmado se abre corretamente na prática real.
- Testes de chat/UI feitos via aba normal com viewport emulado (equivalente em termos de CSS/lógica ao side panel real), não no painel docked de verdade — os bugs de layout devem se replicar idênticos lá, mas vale conferência visual.

## 🔒 Observação de arquitetura (não é bug)

O service worker chama diretamente `https://SEU-GATEWAY/api/v1/chat/completions` (gateway próprio do usuário) com `Authorization: Bearer sk-...` em texto claro, visível em qualquer DevTools aberto na extensão. Esperado para uma extensão client-side sem proxy próprio — reportado só por transparência, já que é um gateway doméstico do próprio usuário.

## ⚠️ Nota operacional

Durante o início deste teste, mensagens de teste foram enviadas sem querer numa conversa real já existente do usuário (renomeada automaticamente para "teste de fumaça: 1..."), e uma segunda conversa de teste ficou registrada como "palavra palavra pa...". Ambas contêm apenas conteúdo de teste (incluindo um payload de injeção HTML inofensivo) e podem ser apagadas pelo usuário via o menu de conversas, se desejado.

---

*Relatório gerado por um agente Claude Code a partir de uma sessão de testes com CDP + observação ao vivo via voz conduzida pelo usuário. Prioridade sugerida: crítico (loop de voz) → bugs de UI → sugestões de investigação/melhoria.*
