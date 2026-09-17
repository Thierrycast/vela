# Mudanças

O que mudou em cada versão, do mais recente para o mais antigo. O detalhe de **por que** cada
decisão foi tomada está em [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## 0.2.0 — navegação agêntica

A reforma que encurtou as tarefas: o gargalo não era capacidade, era o número de idas ao modelo.

### Navegação

- **Identificador de elemento estável.** Um `ref` pertence ao elemento, não à leitura: continua
  valendo depois de clicar, digitar, rolar e reler, inclusive entre leituras. Com conferência de
  assinatura — em lista que recicla linhas, a ação é recusada com o rótulo do item que você queria,
  em vez de clicar no item errado e reportar sucesso.
- **Ações em lote** (`browser_batch`): a sequência previsível vai numa ida só, para no primeiro erro
  e diz o que não chegou a rodar. Um cartão de aprovação para o plano inteiro.
- **Espera por condição** (`waitFor`): texto aparecer, elemento existir, "carregando" sumir, rede
  parar — e a resposta diz por que voltou.
- **Ação em aba de segundo plano** pelo número da aba, sem roubar a tela.
- **Retrato hierárquico**: cada botão aparece dentro do item a que pertence, o que acabou com o
  "qual dos vinte Adicionar é o certo".
- **Escada de leitura**: a captura de tela virou o último degrau e é recusada enquanto não houver
  leitura por texto no mesmo pedido.
- Ações novas: `hover`, `drag`, `selectOption`, `history`, `find` por papel, `evaluateScript`.

### Segurança

- Conteúdo de página chega ao modelo envelopado como não confiável, com detecção de tentativa de
  instrução.
- Endereço sugerido por página pede confirmação antes de ser visitado, inclusive em modo Auto.
- Acesso aos sites virou permissão opcional, concedida no primeiro uso.
- Cada habilidade arriscada tem interruptor próprio, e as arriscadas nascem desligadas.

### Voz

- A resposta começa a ser falada enquanto ainda está sendo escrita.
- O pipeline inteiro entrou na trilha: áudio capturado, transcrição (limpa e bruta), descarte com
  motivo, texto falado, áudio sintetizado e quanto tocou.
- Correção grave: o runtime de voz usava as **preferências de fábrica**, porque um documento
  offscreen não enxerga `chrome.storage` — trocar voz, servidor ou modelo não tinha efeito.

### Trilha e revisão

- **Rastreio completo**: prompt exato, resposta crua, conteúdo integral das leituras e áudio.
- **Relatório em Markdown** e **pacote zip** (relatório + eventos + áudios) para revisar uma sessão
  inteira fora do navegador.

### Desempenho

Medido no Chrome real, página de 8 mil elementos, mediana de dez execuções: leitura 54 → 39 ms,
busca 74 → 49 ms, clique numa página que reage 418 → 132 ms. Também: o formato aceito pelo gateway
passou a ser lembrado (uma recusa por sessão, não por rodada), resultados grandes de pedidos
anteriores viram resumo, o painel desenha por quadro em vez de por token, e cada conversa tem chave
própria no storage — antes as cinquenta eram reescritas juntas a cada pausa.

## 0.1.0

Primeira versão: painel lateral, leitura de página, ações básicas, autonomia em três modos, voz com
orb reativo, trilha de execução, ponte MCP e scripts do usuário.
