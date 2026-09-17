# Guia de uso

O que a Vela faz no dia a dia, e onde cada coisa fica.

## O que a Vela sabe fazer sozinha

**Ler do mais leve ao mais pesado.** Primeiro `find` (quando ela sabe o que procura), depois o
retrato da página, depois o texto do conteúdo, e só no fim a captura de tela — que custa segundos e
milhares de tokens para reconhecer em pixel o que o DOM entrega escrito. A captura fica bloqueada
até ter havido uma leitura por texto no mesmo pedido; quando você pede a imagem ("tira um print",
"como está o layout"), ela vai direto.

**Agrupar o que já é previsível.** Abrir a página, clicar no campo de busca, digitar e apertar
Enter não são quatro conversas com o modelo: são um lote. `browser_batch` executa a sequência numa
ida só e para no primeiro erro, dizendo o que rodou e o que não chegou a rodar. É o que mais
encurta tarefas longas — o custo de uma tarefa quase nunca está no clique, está na rodada que
precede cada clique. Em **Assistir**, você aprova o plano inteiro num cartão só.

**Esperar pelo que deve acontecer.** `waitFor` espera um texto aparecer, um elemento existir, um
"carregando" sumir (`gone`) ou a rede parar — e volta no instante em que acontece, dizendo por quê.
Antes ela chutava milissegundos e errava dos dois lados.

**Trabalhar numa aba sem tirar você da sua.** Toda ação aceita `tabId`, e os refs sabem de que aba
vieram. Numa lista de dez itens, ela abre dez abas e age em cada uma sem trazer nenhuma para a
frente. Só as abas do grupo "Vela" são endereçáveis assim; as suas continuam suas.

**Passar o mouse, arrastar, escolher numa lista, voltar.** `hover` abre menu que só aparece no
ponteiro (e, se o menu for de CSS puro, escala para o ponteiro de verdade pelo depurador — evento
sintético não acende `:hover`); `drag` reordena e move; `selectOption` escolhe pelo texto que
aparece na tela; `history` volta e avança.

**Ler o que a página diz de si mesma.** Com as habilidades ligadas, `read_console_messages` mostra
os erros que o site escreve para si (onde costuma estar o motivo de uma ação não funcionar) e
`read_network_requests` mostra as requisições — que às vezes revelam o endereço com os dados
prontos e poupam uma dezena de cliques. Os dois começam a gravar quando são chamados: chame,
repita a ação, leia de novo. Cabeçalho nenhum é guardado, e token no endereço é apagado.

**Delegar o que vai demorar.** `delegate_task` manda uma tarefa longa para rodar por trás, em aba
própria, enquanto a conversa continua. Duas ao mesmo tempo; o resto espera em fila. Na voz, o
resultado chega falado.

**Olhar a tela.** `screenshot` captura a janela visível e manda a imagem para o modelo — é o
único caminho para o que existe só em pixel: legenda dentro de miniatura de vídeo, gráfico,
imagem sem texto alternativo. Não substitui o retrato: o retrato diz o que dá para clicar, a
captura diz o que a página parece. Só a mais recente fica no contexto, reduzida a 1200px de
largura (de 268 KB para 156 KB, medido), e nenhuma é salva em disco — foto velha mente sobre
uma página que já rolou.

**Achar na página.** Quando ela sabe o texto do que procura, chama `find` em vez de rolar: a
varredura pega o documento inteiro, incluindo o que está fora da tela e dentro de shadow DOM, e
devolve o elemento já pronto para clicar. Rolar ficou sendo o que é — ler conteúdo novo, não
procurar.

**Governar as abas dela.** `tab_manage` lista, foca e fecha as abas do grupo "Vela". Peça "fecha
as abas que você abriu" e ela fecha; abas suas, fora do grupo, ela recusa.

**Insistir do jeito certo quando o site ignora o clique.** Alguns sites só reagem a evento que o
navegador marca como real. Com o **Modo preciso** ligado (Configurações → Agente), um clique que
saiu "sem efeito perceptível" é repetido pelo depurador do Chrome — e a Vela então olha por 700 ms
se a página reagiu, para dizer a verdade em vez de "cliquei de novo". Nasce desligado porque
anexar o depurador faz o Chrome exibir uma faixa de aviso; ela some assim que a ação termina.

**Apagar uma conversa.** No menu de conversas recentes, a lixeira aparece ao passar o mouse na
linha. Apagar não tem volta, então a linha pergunta antes: *Apagar de vez?*

**Mudar as próprias preferências.** "Troca para a voz do Cadu", "usa o mesh field", "desliga o
cursor" — `vela_settings` faz na hora, sem mandar você abrir a tela de configurações. Endereço de
servidor, chaves e a autonomia ficam fora do alcance dela.

**Lembrar de um fato entre conversas.** `memory_write`/`memory_read`/`memory_delete` guardam
preferências ou informações que você pediu para ela lembrar — entram sozinhas na conversa seguinte,
mesmo depois de fechar e abrir de novo. Modo Observar bloqueia escrita e exclusão como bloqueia
qualquer outra ação que muda estado, e há um teto (60 chaves, 2000 caracteres por valor) para a
memória não crescer sem limite.

**Rodar um script na página, como último recurso.** Quando clicar/digitar/teclado não alcançam —
Shadow DOM fechado, evento que só um script dispara — `evaluateScript` injeta JavaScript e lê o
retorno, inclusive de elementos do DOM. Não enxerga variável ou estado que o próprio JavaScript da
página guardou em memória, só o DOM em si.

## Trocar de modelo


O nome do modelo na barra de envio abre a lista do próprio gateway, com busca — sem sair da
conversa. Sem digitar nada aparecem o modelo atual e os cinco últimos usados, que cobrem o dia a
dia; a busca existe porque uma lista de mil e quatrocentos modelos não se navega rolando. A troca
vale para o provider ativo e é a mesma preferência que aparece em Configurações → Providers.

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
estão em [bridge/README.md](../bridge/README.md).

```bash
npm run bridge -- --token=... # só para depurar; o normal é o agente subir o processo
```

O modo de autonomia vale igual para o agente de fora: em Observar ele só lê, e em Assistir cada
ação espera aprovação no painel — sem painel aberto, a ação é recusada.

## Backup das configurações

Configurações → Avançado exporta preferências, providers e scripts num JSON. **A chave de API
fica de fora por padrão** — ligue "Incluir as chaves" só se for guardar o arquivo como se fosse
uma senha. Restaurar um backup sem chave não apaga a que já está configurada na máquina.
