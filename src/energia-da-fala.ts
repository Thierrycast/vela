/**
 * Voz tem energia; eco e ruído não.
 *
 * Os áudios de uma sessão real mostraram a diferença em número: os trechos que o modelo de
 * transcrição transformou em `"."`, `"so"` e `"Thank you."` tinham RMS entre 0,011 e 0,018, contra
 * 0,048 a 0,086 das falas de verdade da mesma pessoa, no mesmo microfone. Não é ambíguo — é uma
 * ordem de grandeza.
 *
 * Barrar aqui, antes de mandar para o servidor, economiza a ida inteira: a transcrição de um
 * trecho de silêncio custa segundos de espera para devolver um ponto final que ainda por cima
 * interromperia a tarefa em andamento.
 *
 * A comparação é **com a própria pessoa**, não com um número universal: microfone, ganho e distância
 * mudam tudo. Enquanto não houver falas aceitas para comparar, só o piso absoluto vale — é melhor
 * transcrever ruído do que engolir a primeira frase de quem acabou de ligar o microfone.
 */

/** Abaixo disto não é fala em nenhum microfone: é linha de base de sala silenciosa. */
const PISO_ABSOLUTO = 0.006;
/** Fração da energia típica da pessoa abaixo da qual o trecho não se sustenta como fala. */
const FRACAO_DA_FALA = 0.3;
/** Quantas falas aceitas bastam para ter uma referência estável. */
const MINIMO_DE_AMOSTRAS = 2;

export function rms(chunks: Float32Array[]): number {
  let soma = 0;
  let total = 0;
  for (const chunk of chunks) {
    for (let indice = 0; indice < chunk.length; indice += 1) soma += chunk[indice] * chunk[indice];
    total += chunk.length;
  }
  return total ? Math.sqrt(soma / total) : 0;
}

export class EnergiaDaFala {
  private aceitas: number[] = [];

  /** A referência é a mediana das últimas falas aceitas — média cede fácil a um grito ou a um sussurro. */
  private referencia(): number | null {
    if (this.aceitas.length < MINIMO_DE_AMOSTRAS) return null;
    const ordenadas = [...this.aceitas].sort((primeira, segunda) => primeira - segunda);
    return ordenadas[Math.floor(ordenadas.length / 2)];
  }

  avaliar(energia: number): { fala: boolean; motivo?: string; referencia: number | null } {
    const referencia = this.referencia();
    if (energia < PISO_ABSOLUTO) return { fala: false, motivo: "trecho praticamente em silêncio", referencia };
    if (referencia !== null && energia < referencia * FRACAO_DA_FALA) {
      return { fala: false, motivo: "energia muito abaixo da sua fala (eco do alto-falante ou ruído de fundo)", referencia };
    }
    return { fala: true, referencia };
  }

  /** Só o que virou pedido de verdade entra na referência. */
  registrarFala(energia: number) {
    this.aceitas = [...this.aceitas.slice(-9), energia];
  }
}
