# Privacidade

A Vela é uma extensão que roda inteira no seu navegador. **Não existe servidor da Vela**: não há
para onde os seus dados irem além dos endereços que você mesmo configurou.

## Para onde vão os seus dados

| Destino | O que vai | Quando |
|---|---|---|
| O **gateway de IA** que você configurou | a conversa, o texto da página lida, a estrutura dos elementos e — se você pedir uma captura — a imagem | a cada ida ao modelo |
| O **servidor de voz** que você configurou | o áudio do microfone (para transcrever) e o texto da resposta (para falar) | só com a voz ligada |
| **Ninguém mais** | — | — |

A extensão não faz telemetria, não tem analytics, não chama nenhum endereço que você não tenha
configurado, e não envia nada em segundo plano quando você não está pedindo algo.

## O que fica guardado na sua máquina

Tudo em `chrome.storage.local` e no IndexedDB do seu perfil do Chrome — nunca sincronizado:

| Dado | Onde | Teto |
|---|---|---|
| Conversas | `chrome.storage.local`, uma chave por conversa | 50 conversas, 200 mensagens cada |
| Preferências e providers (inclusive a chave de API) | `chrome.storage.local` | — |
| Memória entre conversas (o que você pediu para ela lembrar) | `chrome.storage.local` | 60 chaves, 2 000 caracteres por valor |
| Trilha de execução | IndexedDB | 20 mil eventos |
| Áudio da conversa falada (só no rastreio completo) | IndexedDB | 100 MB |
| Scripts do usuário | `chrome.storage.local` | — |

Opções → Avançado mostra o espaço ocupado por categoria e apaga cada uma separadamente.

## O que nunca é gravado

- **Chave de API, cookie, token de autorização e senha** são redigidos antes de qualquer gravação
  na trilha, em qualquer nível de detalhe — é o que permite exportar um relatório sem medo.
- **Campos sensíveis da página** (senha, código de verificação, cartão) chegam ao modelo como
  `[valor omitido]`, e a Vela não os preenche: ela pede que você faça isso.
- **Capturas de tela não são persistidas.** Só a mais recente fica no contexto da conversa, e
  nenhuma vai para o disco.
- O backup de configurações **deixa a chave de fora por padrão**.

## Rastreio completo

O modo de rastreio completo (Opções → Avançado) grava, além do normal, o prompt exato enviado ao
modelo, a resposta crua, o conteúdo integral das leituras de página e o áudio da conversa falada.

Ele nasce **desligado**, e é assim de propósito: nesse nível a trilha guarda o conteúdo das páginas
que você visitou. Ligue para reproduzir um problema, exporte o relatório, e desligue. A redação de
segredos continua valendo — é a única coisa que não afrouxa nesse modo.

## Permissões que a extensão pede, e por quê

| Permissão | Por quê |
|---|---|
| Acesso aos sites (`<all_urls>`, opcional) | ler e agir na página que você abrir. Concedida no primeiro uso, revogável a qualquer momento |
| `scripting`, `tabs`, `webNavigation` | injetar o leitor de página, abrir e endereçar as abas da tarefa |
| `sidePanel`, `storage`, `unlimitedStorage` | o painel e o que fica guardado na máquina |
| `offscreen` | o runtime de áudio da voz |
| `debugger` | repetir um clique como evento real quando o site ignora o caminho normal, e ler console e rede. Declarada, mas **inerte** até você ligar o Modo preciso ou essas habilidades |
| `alarms` | manter a ponte MCP viva entre eventos |
| `tabGroups`, `notifications` (opcionais) | agrupar as abas da tarefa e pedir aprovação com o painel fechado |

## Defesas contra o que a página tenta fazer

- Conteúdo lido de qualquer site chega ao modelo dentro de `<conteudo_nao_confiavel>`: é dado, não
  instrução. Texto que tenta dar ordens é registrado e contado a você.
- Endereço que apareceu **no conteúdo de uma página** (e não num pedido seu) pede confirmação antes
  de ser visitado, inclusive em modo Auto.
- A memória entre conversas nunca é escrita sozinha a partir do conteúdo de um site.
