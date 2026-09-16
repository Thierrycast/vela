# vela-bridge

Expõe a Vela como servidor **MCP** para outros agentes — Codex, Claude Code, ou qualquer cliente
que fale o protocolo. Eles passam a poder ler a página aberta, agir nela, buscar na web e
**delegar uma tarefa inteira** ao modelo que você já configurou na extensão, usando o seu Chrome
logado como contexto.

É um arquivo só, sem dependências. Precisa de Node 18+.

## Como ligar

1. Na extensão: **Configurações → Ponte MCP**. Gere o token, informe o caminho deste arquivo e
   ligue a ponte.
2. Copie o trecho de configuração que a própria tela monta e cole no seu agente.
3. O agente sobe o `vela-bridge` sozinho quando precisa. A extensão o encontra e conecta.

O LED da tela mostra o estado: *Conectada* quando os dois lados se acharam.

### Claude Code

Em `.mcp.json` do projeto (ou `~/.claude.json` para valer em todos):

```json
{
  "mcpServers": {
    "vela": {
      "command": "node",
      "args": ["C:\\caminho\\browser-ai\\bridge\\vela-bridge.mjs"],
      "env": { "VELA_BRIDGE_TOKEN": "seu-token" }
    }
  }
}
```

### Codex

Em `~/.codex/config.toml`:

```toml
[mcp_servers.vela]
command = "node"
args = ["C:\\caminho\\browser-ai\\bridge\\vela-bridge.mjs"]
env = { VELA_BRIDGE_TOKEN = "seu-token" }
```

### Direto, para depurar

```bash
node bridge/vela-bridge.mjs --token=... --port=8792
```

`--port` e `--token` também podem vir de `VELA_BRIDGE_PORT` e `VELA_BRIDGE_TOKEN`.

### A porta é preferência, não requisito

Se a porta escolhida estiver ocupada, a ponte **anda até sete casas acima** (8792–8799 no padrão) e
diz no log qual pegou. A extensão sonda a mesma faixa em `GET /hello` e adota a que se identificar
com o token certo — não é preciso trocar número nenhum à mão.

O que não muda é a porta em **Configurações → Ponte MCP**: ela é a sua intenção, o ponto de partida
da busca. Quando a ponte está numa porta diferente, a tela mostra as duas. Se as oito estiverem
ocupadas, aí sim o processo sai avisando.

## Ferramentas expostas

| Ferramenta | O que faz |
|---|---|
| `vela_read_page` | Lê a aba ativa e devolve a árvore de elementos interativos com refs `[e412]` |
| `vela_act` | Clica, digita, navega, passa o mouse, arrasta, escolhe numa lista, volta no histórico, procura, espera por uma condição, captura a tela ou chama uma ferramenta da própria página |
| `vela_search` | Busca na web pelo provider da Vela, sem abrir aba |
| `vela_fetch` | Lê o conteúdo de uma URL, sem abrir aba |
| `vela_tabs` | Lista as abas que a Vela enxerga |
| `vela_ask` | Delega o objetivo inteiro: a Vela executa no navegador e devolve a resposta |

Os refs vêm de `vela_read_page` ou de `find` e **pertencem ao elemento, não à leitura**: continuam
valendo depois de um clique que reescreveu a tela, e uma releitura devolve o mesmo número para o
mesmo elemento. Eles deixam de valer quando aquela aba navega — aí a resposta diz de onde para onde
ela foi. Se o elemento virou outra coisa (listas que reaproveitam linhas conforme se rola), o erro é
`ref_changed` e a saída é `find` pelo texto, não reler a página inteira. É o mesmo protocolo que a
Vela usa internamente.

**O acesso aos sites é concedido pelo usuário**, não pela instalação: se ninguém tiver clicado em
"Conceder acesso aos sites" em Configurações → Permissões, toda ação volta recusada explicando isso.

## Segurança

**O token não é burocracia.** Um endpoint local sem autenticação significa que qualquer processo
da máquina — inclusive um script baixado sem querer — poderia dirigir o navegador onde você está
logado no banco e no e-mail. O servidor escuta só em `127.0.0.1`, nunca na rede, e compara o token
em tempo constante.

**O modo de autonomia da Vela continua valendo para o agente de fora.** Em *Observar* ele só lê.
Em *Assistir*, cada ação abre o cartão de aprovação no painel — e, se não houver painel aberto,
a ação é **recusada**, não executada em silêncio: um agente externo não é superfície de aprovação,
porque ele não tem como responder ao cartão por você.

## Desenho

A extensão é sempre quem inicia a conexão, por *long-polling* HTTP contra `127.0.0.1`. Não é
WebSocket por dois motivos: o CSP da extensão libera `http://127.0.0.1:*` mas não `ws://`, e um
servidor WebSocket em Node exigiria uma dependência — enquanto `node:http` já está lá.

```
Codex / Claude Code ──stdio (JSON-RPC)──▶ vela-bridge ──HTTP 127.0.0.1──▶ extensão ──▶ Chrome
```

Quando um comando termina, a extensão **interrompe o long-poll em curso** para entregar o
resultado na hora, em vez de esperar o ciclo de 25 s fechar. Na prática a ida e volta fica em
alguns milissegundos.

O service worker do MV3 morre com 30 s ociosos; um `chrome.alarms` de 1 minuto o acorda e reata a
conexão. Se o processo `vela-bridge` cair, a extensão tenta de novo com recuo progressivo até
20 s e mostra *Processo vela-bridge fora do ar* na tela de configurações.
