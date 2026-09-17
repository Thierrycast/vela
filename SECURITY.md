# Segurança

## Relatar uma vulnerabilidade

Abra um [aviso de segurança privado](https://github.com/Thierrycast/vela/security/advisories/new)
no GitHub, ou escreva para o e-mail do mantenedor no perfil. **Não abra issue pública** para falha
explorável.

Diga o que acontece, como reproduzir e qual o impacto. Uma resposta chega em até 7 dias.

## O que é considerado vulnerabilidade aqui

Uma agente de navegador tem uma superfície incomum: ela lê páginas hostis e age numa sessão logada.
O que mais importa:

- **Prompt injection que vira ação.** Uma página que consegue fazer a Vela navegar, clicar, enviar
  dados ou vazar a conversa por instrução escrita no próprio conteúdo. Ela envelopa todo conteúdo
  de página como não confiável e pede confirmação para endereço sugerido por página — furo nessas
  barreiras é falha.
- **Vazamento de segredo.** Chave de API, cookie ou token aparecendo na trilha, no relatório
  exportado, num log ou numa mensagem enviada ao modelo.
- **Escapar do gate de autonomia.** Qualquer caminho que execute ação de escrita em modo Observar,
  ou sem o cartão de aprovação em modo Assistir.
- **Agir onde não devia.** Ação numa aba que não é da sessão da Vela, ou leitura de console/rede de
  uma aba do usuário.
- **XSS na própria extensão.** Conteúdo de página renderizado como HTML no painel (o Markdown é
  construído em nós React justamente para evitar isso).

## O que **não** é vulnerabilidade

- A chave de API ficar visível no DevTools da própria extensão: ela é do usuário, e a extensão é
  client-side por desenho.
- A Vela conseguir agir num site em modo Auto — é o que o modo significa.
- `evaluateScript` executar JavaScript na página: é uma habilidade opcional, desligada de fábrica, e
  o cartão de aprovação mostra o código.

## Escopo

Este repositório. O gateway de IA e o servidor de voz são de quem os hospeda.
