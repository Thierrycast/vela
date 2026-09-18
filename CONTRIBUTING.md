# Contribuir

Obrigado pelo interesse. Este é um projeto pessoal levado a sério: aceita contribuição, e tem
opinião sobre como o código é escrito.

## Antes de abrir um PR

```bash
npm install
npm run typecheck && npm run lint && npm run build && npm run harness
```

Os quatro precisam passar. O `harness` roda o loop do agente inteiro em Node, com provider e página
falsos — é onde erro de lógica aparece sem precisar carregar a extensão.

Mudou algo que a página sente (leitura, clique, espera, refs)? Rode também contra um Chrome real:

```bash
npm run build && node tools/drive.mjs --fixtures --roteiro=tools/fixtures/roteiro-pagina.json
```

Mudou algo de desempenho? Meça antes e depois — o roteiro `roteiro-medicao.json` existe para isso.
Ver [docs/TESTES.md](docs/TESTES.md).

## Integração contínua

Cada PR roda os quatro comandos acima no GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Falhou lá, falha aqui: o harness não
precisa de Chrome nem de chave de API.

## Como o código é escrito aqui

- **Português.** Nomes, comentários, mensagens de erro e commits. Termos técnicos e identificadores
  de API ficam no original.
- **Comentário explica *por quê*, não *o quê*.** Se o comentário descreve o que a linha faz, ele
  sobra. Se ele conta a decisão, o que foi tentado antes e o que quebrou — ele é o mais valioso do
  arquivo. Há muito exemplo disso no código: siga o tom.
- **Mensagem de erro é instrução.** Toda recusa devolvida ao modelo (ou ao usuário) diz o que fazer
  em seguida. "Falhou" sozinho não é aceito em revisão.
- **Nada de sucesso fingido.** Se uma ação não teve efeito, a resposta diz isso. Metade dos bugs
  sérios deste projeto vieram de um caminho que reportava sucesso sem ter acontecido.
- **Decisão relevante vira seção em [docs/ARQUITETURA.md](docs/ARQUITETURA.md)**, com o porquê.

## Commits

Mensagem em português, no imperativo ou descritiva, dizendo **o que mudou e por quê** — o histórico
deste repositório é documentação. Sem linhas de atribuição a ferramentas.

## Abrindo issue

Para bug, diga o site (ou uma página que reproduza), o que você pediu, o que aconteceu e o que você
esperava. Se der, ligue o rastreio completo (Opções → Avançado), reproduza e anexe o **pacote** —
ele traz o relatório, os eventos e os áudios, já com os segredos redigidos.
