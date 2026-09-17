import { SEM_TURNO, TraceEvent } from "./trace";

/**
 * A trilha virada narrativa.
 *
 * Um arquivo JSONL com quatrocentos eventos responde qualquer pergunta e não conta nada: para
 * entender um turno é preciso reconstruir a ordem, casar cada chamada com seu resultado, somar as
 * durações e lembrar o que veio antes. Ninguém faz isso de cabeça na décima vez.
 *
 * Este módulo faz a reconstrução uma vez e entrega o que se lê de cima para baixo: o que a pessoa
 * pediu, o que a Vela leu, o que decidiu em cada rodada, o que executou, o que voltou, quanto
 * custou e onde falhou. É o mesmo material do JSONL — a diferença é que este dá para ler.
 *
 * Markdown, e não HTML, por um motivo prático: o destino provável é uma conversa com outro modelo,
 * uma issue ou um documento. Markdown atravessa os três sem perder estrutura.
 */

const duracao = (ms: number | undefined) => ms === undefined ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
const hora = (at: number) => new Date(at).toLocaleTimeString("pt-BR");

/** Texto de payload dentro de bloco de código, sem deixar a cerca ser fechada pelo conteúdo. */
function bloco(texto: string, linguagem = "") {
  const cerca = texto.includes("```") ? "````" : "```";
  return `${cerca}${linguagem}\n${texto.trimEnd()}\n${cerca}`;
}

const texto = (valor: unknown) => typeof valor === "string" ? valor : JSON.stringify(valor, null, 2);

/**
 * O uso de tokens em uma linha lida por gente.
 *
 * O gateway devolve o objeto cru, e despejá-lo no relatório dava três linhas de JSON no meio da
 * narrativa para dizer um número que interessa em uma. Campos que o gateway não mandar simplesmente
 * não aparecem — inventar zero seria afirmar algo que ninguém mediu.
 */
function contarTokens(tokens: Record<string, unknown>): string {
  const numero = (campo: string) => typeof tokens[campo] === "number" ? tokens[campo] as number : undefined;
  const partes = [
    numero("prompt_tokens") !== undefined ? `${numero("prompt_tokens")} de entrada` : "",
    numero("completion_tokens") !== undefined ? `${numero("completion_tokens")} de saída` : "",
    numero("total_tokens") !== undefined ? `${numero("total_tokens")} no total` : "",
  ].filter(Boolean);
  return partes.length ? `tokens: ${partes.join(" · ")}` : `tokens: ${texto(tokens)}`;
}

type Turno = { id: string; eventos: TraceEvent[] };

export function agruparPorTurno(eventos: TraceEvent[]): Turno[] {
  const mapa = new Map<string, TraceEvent[]>();
  for (const evento of eventos) mapa.set(evento.turn, [...(mapa.get(evento.turn) ?? []), evento]);
  return [...mapa.entries()].map(([id, lista]) => ({ id, eventos: lista }));
}

/** O cabeçalho responde, em cinco linhas, se vale a pena ler o resto. */
function resumo(eventos: TraceEvent[]): string {
  const turno = eventos.find((evento) => evento.kind === "turn" && evento.ms !== undefined);
  const entrada = eventos.find((evento) => evento.kind === "user.input");
  const rodadas = new Set(eventos.filter((evento) => evento.round !== undefined).map((evento) => evento.round)).size;
  const chamadas = eventos.filter((evento) => evento.kind === "tool.call" && evento.ms !== undefined);
  const acoes = eventos.filter((evento) => evento.kind === "action" && evento.ms !== undefined);
  const falhas = eventos.filter((evento) => evento.ok === false);
  const semEfeito = acoes.filter((evento) => (evento.data as { noEffect?: boolean } | undefined)?.noEffect);
  const tokens = eventos
    .map((evento) => (evento.data as { tokens?: { total_tokens?: number } } | undefined)?.tokens?.total_tokens)
    .filter((valor): valor is number => typeof valor === "number");
  const dados = (entrada?.data ?? {}) as Record<string, unknown>;

  const linhas = [
    `- **Pedido:** ${String(dados.texto ?? entrada?.label ?? "—").replace(/\n+/g, " ").slice(0, 300)}`,
    `- **Quando:** ${eventos[0] ? new Date(eventos[0].at).toLocaleString("pt-BR") : "—"}`,
    `- **Duração:** ${duracao(turno?.ms) || "não fechou"} · **${rodadas} rodada(s)** · ${chamadas.length} chamada(s) de ferramenta · ${acoes.length} ação(ões) na página`,
    `- **Modelo:** ${String(dados.model ?? "—")} · **autonomia:** ${String(dados.autonomia ?? "—")}${dados.modoPreciso ? " · modo preciso ligado" : ""}`,
    `- **Entrou por:** ${String((eventos.find((evento) => evento.kind === "user.input" && (evento.data as { origem?: string } | undefined)?.origem)?.data as { origem?: string } | undefined)?.origem ?? "texto")}`,
  ];
  if (tokens.length) linhas.push(`- **Tokens:** ${tokens.reduce((soma, valor) => soma + valor, 0)} no turno`);
  linhas.push(`- **Desfecho:** ${falhas.length ? `${falhas.length} falha(s)` : "sem falhas"}${semEfeito.length ? ` · ${semEfeito.length} ação(ões) sem efeito perceptível` : ""}`);
  if (dados.habilidades) linhas.push(`- **Habilidades ligadas:** ${(dados.habilidades as string[]).join(", ")}`);
  return linhas.join("\n");
}

/**
 * A conversa falada, do microfone à caixa de som.
 *
 * Numa conversa por voz o texto é o meio, não a ponta: entre o que a pessoa disse e o que a Vela
 * leu há um modelo de transcrição, e entre o que ela respondeu e o que se ouviu há outro de
 * síntese. Cada um deles pode ser o culpado, e nenhum aparecia no relatório — que começava já com
 * o texto transcrito, como se ele fosse o fato.
 */
function voz(eventos: TraceEvent[]): string {
  // Ordem de início, não de fim: uma etapa medida grava quando termina, e a síntese em streaming só
  // termina depois de tocar — pela ordem de gravação, "tocou" aparecia antes de "síntese".
  // Quando duas etapas começam no mesmo instante (a duração é arredondada ao milissegundo), vale a
  // ordem do pipeline: na reprodução em streaming a síntese e o toque nascem juntos.
  const inicio = (evento: TraceEvent) => evento.at - (evento.ms ?? 0);
  const ORDEM: Record<string, number> = { "audio.capture": 0, "stt.partial": 1, "stt.result": 2, "tts.request": 3, "tts.audio": 4, "tts.play": 5 };
  const etapas = eventos
    .filter((evento) => evento.kind.startsWith("audio.") || evento.kind.startsWith("stt.") || evento.kind.startsWith("tts."))
    .sort((primeiro, segundo) => {
      const diferenca = inicio(primeiro) - inicio(segundo);
      return Math.abs(diferenca) < 20 ? (ORDEM[primeiro.kind] ?? 9) - (ORDEM[segundo.kind] ?? 9) : diferenca;
    });
  if (!etapas.length) return "";

  const linhas = ["## A conversa falada", ""];
  for (const evento of etapas) {
    const dados = (evento.data ?? {}) as Record<string, unknown>;
    const quando = hora(inicio(evento));
    const audio = evento.blobId ? ` · áudio \`${evento.blobId.slice(0, 8)}\`` : "";

    if (evento.kind === "audio.capture") {
      linhas.push(`- \`${quando}\` **microfone** — trecho de ${Math.round(Number(dados.bytes ?? 0) / 1024)} kB${audio}`);
    } else if (evento.kind === "stt.result") {
      const descartado = dados.descartado === true;
      linhas.push(`- \`${quando}\` **transcrição** (${String(dados.modelo ?? "modelo n/d")}, ${duracao(evento.ms)})${audio}`);
      linhas.push(`  - ouviu: “${String(dados.texto ?? "")}”`);
      if (dados.bruto && dados.bruto !== dados.texto) linhas.push(`  - bruto: “${String(dados.bruto)}”`);
      if (descartado) linhas.push(`  - **descartado**: ${String(dados.motivo ?? "sem motivo registrado")} — nenhum turno foi aberto`);
    } else if (evento.kind === "stt.partial") {
      linhas.push(`- \`${quando}\` _rascunho_: “${String(dados.texto ?? "")}”${dados.fechado ? " (fechado)" : ""}`);
    } else if (evento.kind === "tts.request") {
      linhas.push(`- \`${quando}\` **mandou falar** (voz ${String(dados.voz ?? "n/d")}, ${String(dados.streaming ? "streaming" : "arquivo")})`);
      if (dados.original !== dados.falado) {
        linhas.push(`  - escrito: “${String(dados.original ?? "").slice(0, 300)}”`);
        linhas.push(`  - falado: “${String(dados.falado ?? "").slice(0, 300)}”`);
      } else {
        linhas.push(`  - texto: “${String(dados.falado ?? "").slice(0, 300)}”`);
      }
    } else if (evento.kind === "tts.audio") {
      linhas.push(`- \`${quando}\` **síntese** ${evento.ok === false ? `falhou (${evento.code ?? "erro"})` : `pronta em ${duracao(evento.ms)}, ${Math.round(Number(dados.bytes ?? 0) / 1024)} kB`}${audio}`);
    } else if (evento.kind === "tts.play") {
      linhas.push(`- \`${quando}\` **tocou** por ${duracao(evento.ms)}${dados.segundos ? ` (${Number(dados.segundos).toFixed(1)} s de áudio)` : ""}${audio}`);
    }
  }
  linhas.push("", "_Os ids de áudio referem-se aos arquivos exportados junto do relatório._", "");
  return `${linhas.join("\n")}\n`;
}

/** As falhas primeiro, porque numa revisão é por elas que se começa. */
function problemas(eventos: TraceEvent[]): string {
  const falhas = eventos.filter((evento) => evento.ok === false);
  const semEfeito = eventos.filter((evento) => evento.kind === "action" && (evento.data as { noEffect?: boolean } | undefined)?.noEffect);
  if (!falhas.length && !semEfeito.length) return "";
  const linhas = ["## O que deu errado", ""];
  for (const evento of falhas) {
    linhas.push(`- \`${evento.code ?? "erro"}\` em **${evento.label}**${evento.round ? ` (rodada ${evento.round})` : ""} — ${String((evento.data as { summary?: string } | undefined)?.summary ?? "").slice(0, 300)}`);
  }
  for (const evento of semEfeito) {
    linhas.push(`- **sem efeito perceptível** em ${evento.label}${evento.round ? ` (rodada ${evento.round})` : ""}: a ação saiu e a página não reagiu.`);
  }
  return `${linhas.join("\n")}\n`;
}

function descreverRodada(numero: number, eventos: TraceEvent[], completo: boolean): string {
  const daRodada = eventos.filter((evento) => evento.round === numero);
  const pedido = daRodada.find((evento) => evento.kind === "model.request");
  const prompt = daRodada.find((evento) => evento.kind === "model.prompt");
  const resposta = daRodada.find((evento) => evento.kind === "model.response");
  const dadosPedido = (pedido?.data ?? {}) as Record<string, unknown>;

  const linhas = [`### Rodada ${numero}`, ""];
  linhas.push(`_${duracao(pedido?.ms)}${dadosPedido.firstTokenMs ? ` · primeiro token em ${duracao(Number(dadosPedido.firstTokenMs))}` : ""}${dadosPedido.chars ? ` · ${dadosPedido.chars} caracteres de resposta` : ""}_`);
  linhas.push("");

  if (completo && prompt) {
    const dados = prompt.data as { mensagens?: Array<Record<string, unknown>>; caracteres?: number; ferramentas?: string[] };
    linhas.push(`<details><summary>O que o modelo leu (${dados.mensagens?.length ?? 0} mensagens, ${dados.caracteres ?? 0} caracteres)</summary>`, "");
    if (dados.ferramentas?.length) linhas.push(`Ferramentas oferecidas: ${dados.ferramentas.map((nome) => `\`${nome}\``).join(", ")}`, "");
    for (const mensagem of dados.mensagens ?? []) {
      linhas.push(`**${String(mensagem.papel)}**`, "", bloco(texto(mensagem.conteudo)), "");
      if (mensagem.chamadas) linhas.push(`chamou: ${bloco(texto(mensagem.chamadas), "json")}`, "");
    }
    linhas.push("</details>", "");
  }

  if (resposta) {
    const dados = resposta.data as { texto?: string; chamadas?: Array<{ nome: string; argumentos: string }>; tokens?: Record<string, unknown> };
    if (dados.texto?.trim()) linhas.push("**O modelo respondeu:**", "", bloco(dados.texto), "");
    if (dados.chamadas?.length) {
      linhas.push("**E decidiu chamar:**", "");
      for (const chamada of dados.chamadas) linhas.push(`- \`${chamada.nome}\` ${bloco(chamada.argumentos, "json")}`);
      linhas.push("");
    }
    if (dados.tokens) linhas.push(`_${contarTokens(dados.tokens)}_`, "");
  }

  // Cada chamada com o que ela de fato devolveu, e as ações que ela disparou por dentro.
  for (const chamada of daRodada.filter((evento) => evento.kind === "tool.call" && evento.ms !== undefined)) {
    const dados = (chamada.data ?? {}) as { name?: string; arguments?: unknown; result?: string };
    const inteiro = daRodada.find((evento) => evento.kind === "model.tool" && evento.callId === chamada.callId);
    const acoes = eventos.filter((evento) => evento.kind === "action" && evento.callId === chamada.callId && evento.ms !== undefined);
    linhas.push(`#### ${chamada.ok === false ? "✗" : "✓"} ${dados.name ?? chamada.label} — ${duracao(chamada.ms)}`, "");
    linhas.push(bloco(texto(dados.arguments ?? {}), "json"), "");
    for (const acao of acoes) {
      const dadosAcao = (acao.data ?? {}) as { summary?: string; noEffect?: boolean };
      linhas.push(`- ação \`${acao.label}\` (${duracao(acao.ms)}): ${dadosAcao.summary ?? ""}${dadosAcao.noEffect ? " **← sem efeito**" : ""}`);
    }
    if (acoes.length) linhas.push("");
    const resultado = (inteiro?.data as { resultado?: string } | undefined)?.resultado ?? dados.result;
    if (resultado) {
      const grande = resultado.length > 1200;
      linhas.push(grande ? `<details><summary>Resultado (${resultado.length} caracteres)</summary>\n` : "**Resultado:**", "");
      linhas.push(bloco(resultado), "");
      if (grande) linhas.push("</details>", "");
    }
  }
  return linhas.join("\n");
}

export type ReportOptions = { completo?: boolean };

/**
 * O relatório de um turno, de cima para baixo.
 *
 * `completo` decide se o prompt entra. Ele é longo — dezenas de milhares de caracteres — e só
 * existe se o rastreio completo estava ligado quando o turno rodou; incluí-lo por padrão faria o
 * relatório começar por dez páginas de system prompt antes de dizer o que aconteceu.
 */
export function relatorioDoTurno(eventos: TraceEvent[], options: ReportOptions = {}): string {
  const ordenados = [...eventos].sort((primeiro, segundo) => primeiro.at - segundo.at);
  if (!ordenados.length) return "# Turno vazio\n";
  const rodadas = [...new Set(ordenados.filter((evento) => evento.round !== undefined).map((evento) => evento.round!))].sort((a, b) => a - b);

  const partes = [
    `# Turno ${ordenados[0].turn.slice(0, 8)}`,
    "",
    resumo(ordenados),
    "",
    problemas(ordenados),
    voz(ordenados),
    "## Como foi, rodada a rodada",
    "",
    ...rodadas.map((numero) => descreverRodada(numero, ordenados, options.completo ?? false)),
  ];

  const finais = ordenados.filter((evento) => evento.kind === "model.text");
  if (finais.length) {
    partes.push("## Resposta final ao usuário", "", bloco(String((finais[finais.length - 1].data as { texto?: string }).texto ?? "")), "");
  }

  // O rodapé existe para quem for reproduzir: sem os eventos soltos, algumas perguntas ficam sem
  // resposta — aprovações, navegação, voz e tudo que não nasceu dentro de uma rodada.
  const soltos = ordenados.filter((evento) => evento.round === undefined && !["turn", "user.input", "model.text"].includes(evento.kind));
  if (soltos.length) {
    partes.push("## Fora das rodadas", "");
    for (const evento of soltos) partes.push(`- \`${hora(evento.at)}\` **${evento.kind}** ${evento.label}${evento.ms !== undefined ? ` (${duracao(evento.ms)})` : ""}${evento.ok === false ? ` — falhou: ${evento.code ?? ""}` : ""}`);
    partes.push("");
  }

  return partes.join("\n");
}

/**
 * O que a extensão gravou sem estar dentro de um turno.
 *
 * O painel abre, o orb monta, a ponte responde — tudo isso acontece fora de qualquer pedido, e a
 * trilha carimba esses eventos com o turno de reserva. Tratá-los como turno produzia um "Turno
 * sem-turn" com pedido vazio, zero rodadas e duração "não fechou": um relatório que parece quebrado
 * logo no fim, justamente onde quem lê procura o desfecho.
 */
function avulsos(eventos: TraceEvent[]): string {
  const ordenados = [...eventos].sort((primeiro, segundo) => primeiro.at - segundo.at);
  const linhas = ["# Fora de qualquer turno", "", `${ordenados.length} evento(s) que não pertencem a um pedido — abertura de painel, ponte, voz ociosa.`, ""];
  for (const evento of ordenados) {
    linhas.push(`- \`${hora(evento.at)}\` **${evento.kind}** ${evento.label}${evento.ms !== undefined ? ` (${duracao(evento.ms)})` : ""}${evento.ok === false ? ` — falhou: ${evento.code ?? ""}` : ""}`);
  }
  return linhas.join("\n") + "\n";
}

/**
 * A fala que abriu o turno volta para dentro dele.
 *
 * A captura, os rascunhos e a transcrição acontecem antes de o turno existir — o turno nasce da
 * transcrição —, então esses eventos ficam carimbados como "sem turno" e o relatório mostrava a
 * resposta da Vela sem a pergunta que a causou. A costura é pelo id do enunciado, que viaja do
 * offscreen até o evento de entrada do turno: nada aqui é deduzido por proximidade no tempo.
 */
function adotarFalaDoTurno(todos: Turno[]): Turno[] {
  const soltos = todos.find((turno) => turno.id === SEM_TURNO);
  if (!soltos) return todos;
  const donoDe = new Map<string, string>();
  for (const turno of todos) {
    if (turno.id === SEM_TURNO) continue;
    const entrada = turno.eventos.find((evento) => evento.kind === "user.input");
    const id = (entrada?.data as { enunciado?: string } | undefined)?.enunciado;
    if (id) donoDe.set(id, turno.id);
  }
  if (!donoDe.size) return todos;

  const sobraram: TraceEvent[] = [];
  const adotados = new Map<string, TraceEvent[]>();
  for (const evento of soltos.eventos) {
    const id = (evento.data as { enunciado?: string } | undefined)?.enunciado;
    const dono = id ? donoDe.get(id) : undefined;
    if (!dono) { sobraram.push(evento); continue; }
    adotados.set(dono, [...(adotados.get(dono) ?? []), { ...evento, turn: dono }]);
  }
  return todos
    .map((turno) => turno.id === SEM_TURNO ? { ...turno, eventos: sobraram } : { ...turno, eventos: [...turno.eventos, ...(adotados.get(turno.id) ?? [])] })
    .filter((turno) => turno.eventos.length);
}

/**
 * Um turno só, mas com a fala que o abriu.
 *
 * Recebe a trilha inteira e o turno desejado, e não apenas os eventos daquele turno: a captura e a
 * transcrição estão fora dele até a adoção acontecer, e quem passasse só a fatia já teria perdido
 * exatamente o que se quer ler.
 */
export function relatorioDeUmTurno(eventos: TraceEvent[], turno: string, options: ReportOptions = {}): string {
  const alvo = adotarFalaDoTurno(agruparPorTurno(eventos)).find((item) => item.id === turno);
  return alvo ? relatorioDoTurno(alvo.eventos, options) : "# Turno vazio\n";
}

/** Vários turnos num arquivo só, do mais recente para o mais antigo. */
export function relatorioCompleto(eventos: TraceEvent[], options: ReportOptions = {}): string {
  const todos = adotarFalaDoTurno(agruparPorTurno(eventos)).reverse();
  const turnos = todos.filter((turno) => turno.id !== SEM_TURNO);
  const soltos = todos.find((turno) => turno.id === SEM_TURNO);
  const cabecalho = [
    "# Relatório de execução da Vela",
    "",
    `Gerado em ${new Date().toLocaleString("pt-BR")} · ${eventos.length} eventos · ${turnos.length} turno(s)`,
    "",
    options.completo
      ? "_Rastreio completo: o prompt exato e o conteúdo integral de cada leitura estão incluídos._"
      : "_Rastreio normal: textos longos aparecem recortados. Ligue o rastreio completo em Configurações → Avançado para a próxima sessão._",
    "",
    "---",
    "",
  ].join("\n");
  const corpo = turnos.map((turno) => relatorioDoTurno(turno.eventos, options));
  if (soltos) corpo.push(avulsos(soltos.eventos));
  return cabecalho + corpo.join("\n\n---\n\n");
}
