# Trilha de execução

Cada requisição ao modelo, chamada de ferramenta, ação na página e falha — com duração e
payload. É a matéria-prima para ajustar o que está lento ou errando, em vez de adivinhar pelo
resultado final. Fica em IndexedDB, guarda os 20 mil eventos mais recentes e não sai do
navegador. Chave de API e afins são redigidas antes de gravar, então a exportação pode ser
anexada num relatório.

**Visor em tempo real:** Configurações → Avançado → *Abrir a trilha*, ou `debug.html` na
extensão. Os eventos aparecem enquanto acontecem, agrupados por turno, com duração ao lado,
filtro por tipo, busca no payload e exportação.

O botão **Marcar** insere uma linha na trilha com o que você vai testar agora. Numa sessão de
depuração a dois é o que separa um caso do outro: sem o marco, o arquivo exportado é uma fita
longa onde tudo se parece.

### Rastreio completo — quando a pergunta é "por que ela fez isso?"

A trilha normal diz o que aconteceu e quanto demorou. Ela **não** guarda o que o modelo leu — e é
aí que mora a resposta. Ligue **Configurações → Avançado → Rastreio completo** antes de reproduzir
o problema, e passam a ser gravados:

- o **prompt exato** que o modelo recebeu, mensagem por mensagem, com as ferramentas oferecidas;
- a **resposta inteira** dele, inclusive a que virou chamada de ferramenta e some da conversa;
- o **conteúdo integral** de cada leitura de página, em vez do começo dela;
- os **tokens** de cada rodada, quando o provider os informa;
- na voz: o **áudio capturado**, o que o STT entendeu (limpo e bruto, com o modelo e o tempo), o
  que foi descartado **e por quê**, o texto que foi mandado falar, o áudio sintetizado e quanto
  ele tocou de fato.

Chave, cookie, token e senha continuam redigidos — isso não muda em nenhum nível.

**Exportar**, no visor da trilha:

| Botão | O que sai |
|---|---|
| **Pacote** | zip com `relatorio.md`, `eventos.jsonl` e a pasta `audio/` — é o que se manda para alguém |
| **Relatório** | só o Markdown, com a narrativa do turno de cima para baixo |
| **JSONL** | os eventos crus, para análise com ferramenta |
| **relatório** (no cabeçalho de cada turno) | o Markdown de um turno só |

Clicar num evento com áudio abre um player ali mesmo: a transcrição é interpretação, o áudio é o
fato. Desligue quando terminar — o modo é caro em disco justamente porque guarda o conteúdo das
páginas visitadas.

**Na voz**, o botão de gravar do palco faz isso em um clique: liga o rastreio completo, e ao parar
baixa o pacote já montado com a sessão inteira. O nível volta sozinho ao que estava antes.

**Dirigir a Vela de fora**, como se fosse uma pessoa:

```bash
npm run drive                       # roteiro padrão: abre uma página, manda uma mensagem, confere
npm run drive -- --roteiro=meu.json # roteiro próprio
npm run drive -- --saida=trace.jsonl
npm run drive -- --manter           # deixa o Chrome aberto no fim
```

Abre um Chrome real com a extensão real, executa os passos e devolve **a trilha**, não uma
captura de tela: quais eventos saíram, os cinco mais demorados e o que falhou. Testar um agente
lendo só a resposta final não diz nada sobre o caminho.

Um roteiro é uma lista de passos — `definirSettings`, `abrirPagina`, `digitar`, `clicar`,
`esperar`, `esperarParar`, `conferir`. `digitar` usa o setter nativo de `value` e dispara
`input`: mexer só na propriedade não avisa o React, e a mensagem nunca sairia.

A ponte MCP expõe **`vela_trace`**, então um agente de fora também lê a trilha para descobrir o
que ficou lento sem precisar do navegador na frente.
