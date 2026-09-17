# Vela

[![CI](https://github.com/Thierrycast/vela/actions/workflows/ci.yml/badge.svg)](https://github.com/Thierrycast/vela/actions/workflows/ci.yml)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)

**Uma agente que opera o seu Chrome.** Ela lê a página como texto — não como imagem —, navega,
clica, digita e conversa com você por voz, num painel lateral. Tudo roda no seu navegador, com a
sua sessão já logada, contra o gateway de modelos que **você** escolher.

> Extensão Chrome MV3, em português, sem servidor próprio: o que sai da sua máquina vai direto para
> o seu provedor de IA.

```
você: "procura um teclado mecânico até 300 reais nessa loja e me diz os três mais baratos"
Vela: abre a busca, digita, espera o resultado carregar, lê a lista e responde — em duas idas
      ao modelo, não em oito.
```

---

## Sumário

- [O que ela faz](#o-que-ela-faz)
- [Instalar](#instalar)
- [Primeiro uso](#primeiro-uso)
- [Como ela decide](#como-ela-decide)
- [Autonomia: quem manda](#autonomia-quem-manda)
- [Voz](#voz)
- [Privacidade e segurança](#privacidade-e-segurança)
- [Documentação](#documentação)
- [Desenvolvimento](#desenvolvimento)
- [Limitações conhecidas](#limitações-conhecidas)
- [Licença](#licença)

---

## O que ela faz

**Lê a página do jeito barato.** A leitura padrão é o texto e a estrutura do DOM: títulos, campos,
botões — cada um com um identificador estável que continua valendo depois de clicar, digitar ou
reler. Captura de tela é o último recurso, e só para o que existe apenas em pixel.

**Agrupa o que já é previsível.** Abrir a página, clicar no campo, digitar e apertar Enter é um
lote só, numa ida ao modelo. É o que mais encurta tarefa longa: o custo quase nunca está no clique,
está na rodada que precede cada clique.

**Espera pelo que deve acontecer.** Um texto aparecer, um "carregando" sumir, a rede parar — e
volta no instante em que acontece, dizendo por quê. Ela não chuta milissegundos.

**Trabalha numa aba sem tirar você da sua.** Toda ação aceita o número da aba, e os identificadores
sabem de onde vieram. Numa lista de dez itens, ela abre dez abas e age em cada uma sem trazer
nenhuma para a frente. Só as abas que ela abriu — as suas continuam suas.

**Mostra o que está fazendo.** Um cursor viaja até o alvo antes de cada ação, o elemento acende, e
uma moldura diz que a sessão é dela. Você vê o caminho, não só o resultado.

**Conversa por voz.** Microfone, transcrição, resposta falada e um orb que reage ao áudio de
verdade. A resposta começa a ser falada enquanto ainda está sendo escrita.

**Delega o que vai demorar.** Uma tarefa de várias etapas roda em segundo plano, em aba própria,
enquanto a conversa continua. O resultado chega sozinho — falado, se a conversa for por voz.

**Guarda a trilha do que fez.** Cada requisição, chamada de ferramenta e ação fica registrada, com
duração. Quando algo dá errado, dá para exportar um relatório em Markdown da sessão inteira.

---

## Instalar

Requer **Node 20+** e **Chrome 116+**.

```bash
git clone https://github.com/Thierrycast/vela.git
cd vela
npm install
npm run build
```

Depois, em `chrome://extensions`:

1. Ligue **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione a pasta `dist/`.
3. Fixe a Vela na barra e clique no ícone para abrir o painel.

A cada `npm run build`, clique em **Atualizar** no card da extensão.

---

## Primeiro uso

1. **Conceder acesso aos sites** (Opções → Permissões). O acesso não vem junto com a instalação:
   você concede com um clique, quando já sabe para que serve, e a extensão reinicia para valer.
2. **Configurar o provedor** (Opções → Providers): endereço do gateway e chave de API. Clique em
   **Modelos** para carregar a lista e escolha um modelo **com suporte a tools** — sem isso, ela só
   conversa. Qualquer gateway compatível com a API de chat da OpenAI serve.
3. **Sondar endpoints** (Opções → Providers → Diagnóstico): descobre o que o seu gateway expõe e
   liga as capacidades correspondentes (busca na web, leitura de URL).
4. **Voz** (opcional): um servidor de fala compatível com `/v1/audio/speech` e
   `/v1/audio/transcriptions`. O microfone precisa ser liberado **a partir da página de opções** —
   o runtime de áudio roda num documento offscreen, que não consegue exibir o prompt do Chrome.

---

## Como ela decide

A ordem das ferramentas é uma escada, do mais leve ao mais pesado — e ela é cumprida no código, não
só pedida no prompt:

| Degrau | Quando |
|---|---|
| `find` | você sabe o texto do que procura — varre o documento inteiro, inclusive fora da tela |
| `extractPage` | ver a estrutura e pegar os identificadores para agir |
| `extractPage` (modo texto) | ler conteúdo: preço, mensagem, artigo, tabela |
| `evaluateScript` | o dado que não aparece como texto (habilidade opcional) |
| `screenshot` | só o que existe em pixel: foto, gráfico, cor, layout |

A captura de tela é recusada enquanto não houver uma leitura por texto no mesmo pedido — a recusa
diz qual degrau usar, e a tentativa seguinte passa. Quando **você** pede a imagem ("tira um print",
"como está o layout"), ela vai direto.

Medido no Chrome real, numa página de 8 mil elementos (mediana de dez execuções): ler 39 ms,
procurar 49 ms, clicar numa página que reage 132 ms.

---

## Autonomia: quem manda

| Modo | O que ela pode |
|---|---|
| **Observar** | só lê. O cursor mostra o que ela faria, e nada acontece |
| **Assistir** | age, mas pede aprovação antes de cada ação que muda a página (um cartão por lote) |
| **Auto** | age sozinha — e ainda assim pergunta antes de comprar, pagar, enviar dados pessoais ou apagar |

Cada habilidade mais poderosa tem interruptor próprio em Opções → Habilidades, e as arriscadas
nascem desligadas: executar script na página, sessão de depurador, leitura de console e de rede.

---

## Voz

Conversa falada completa: detecção de fala, transcrição, resposta falada e texto ao vivo enquanto
você fala. A resposta começa a ser dita frase a frase, sem esperar o modelo terminar de escrever.

O visual que reage à sua voz tem cinco opções — e uma sexta que **você escreve**, num editor de
shader com prévia ao vivo.

Detalhes em [docs/VOZ.md](docs/VOZ.md).

---

## Privacidade e segurança

- **Sem servidor da Vela.** Não existe backend nosso: o que sai do navegador vai para o seu
  provedor de IA e para o seu servidor de voz, e para mais ninguém.
- **A chave fica no seu perfil do Chrome** e é redigida em qualquer registro ou exportação.
- **Conteúdo de página é dado, nunca ordem.** Tudo que vem de um site chega ao modelo dentro de um
  envelope de conteúdo não confiável, e uma página que tenta dar ordens é registrada e denunciada.
- **Endereço sugerido por uma página pede confirmação** antes de ser visitado, inclusive em modo
  Auto — é a porta por onde um site conduziria a sua sessão logada para outro lugar.
- **Campos sensíveis não são preenchidos:** senha, código de verificação e cartão chegam ao modelo
  como `[valor omitido]`.

Detalhes, e o que fica gravado em cada nível, em [docs/PRIVACIDADE.md](docs/PRIVACIDADE.md). Para
relatar um problema de segurança, ver [SECURITY.md](SECURITY.md).

---

## Documentação

| Documento | O que tem |
|---|---|
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | o desenho e **por que** cada decisão foi tomada — inclusive as que deram errado antes |
| [docs/USO.md](docs/USO.md) | o guia de uso: o que ela faz, trocar de modelo, scripts, ponte MCP, backup |
| [docs/VOZ.md](docs/VOZ.md) | pipeline de voz, visuais, shader do usuário |
| [docs/TRILHA.md](docs/TRILHA.md) | trilha de execução, rastreio completo e o relatório de revisão |
| [docs/TESTES.md](docs/TESTES.md) | harness, Chrome real dirigido por roteiro, medição de desempenho |
| [docs/PRIVACIDADE.md](docs/PRIVACIDADE.md) | o que é guardado, onde, e o que nunca sai |
| [docs/MOVIMENTO.md](docs/MOVIMENTO.md) | a camada de movimento (orb, cursor, presença) |
| [bridge/README.md](bridge/README.md) | expor a Vela como servidor MCP para outros agentes |

---

## Desenvolvimento

```bash
npm run build       # build completo — é o que gera dist/
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run harness     # exercita o loop do agente em Node, com provider e página falsos
npm run drive       # dirige um Chrome real com a extensão carregada
npm run ui          # serve a interface em localhost, para revisar sem a extensão
npm run bridge      # sobe a ponte MCP manualmente (o normal é o agente subir)
```

Estrutura:

```
src/        código da extensão (service worker, painel, content script, offscreen)
public/     manifest, ícones, fonte e AudioWorklet (copiados sem processamento)
tools/      harness, driver de Chrome real, fixtures e preview de interface
bridge/     servidor MCP que expõe a Vela para outros agentes
docs/       arquitetura e guias
```

Contribuições: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Limitações conhecidas

- Não age em `chrome://`, na Chrome Web Store nem em PDFs — nessas páginas ela avisa o modelo com
  um erro explícito em vez de fingir sucesso.
- Sites que exigem evento de entrada confiável (upload, canvas, alguns formulários) não respondem
  ao caminho DOM. Com o **Modo preciso** ligado, a ação é repetida pelo depurador do Chrome; sem
  ele, volta como "sem efeito perceptível" — que é informação, não sucesso fingido.
- Em **Assistir** com o painel fechado e sem voz ativa não há onde pedir aprovação: a ação é
  recusada e o modelo é informado.
- A captura mostra só a parte visível da janela.
- Um turno de conversa por vez: falar por cima interrompe o turno atual e o substitui. O que tem
  fila é a tarefa em segundo plano — duas ao mesmo tempo, as demais esperando.
- Script no mundo da página não roda em site com política de segurança estrita; a resposta diz isso
  com todas as letras em vez de devolver um erro opaco.

---

## Licença

[MIT](LICENSE) © Thierry Castro
