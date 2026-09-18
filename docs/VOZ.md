# Voz

**A voz fala com um servidor próprio, separado do provider de texto.** O gateway de chat não
expõe transcrição nem síntese, e exigir a chave dele para gravar deixava os botões de voz mortos
sem dizer por quê. Configurações → Voz tem endereço, chave opcional, teste de conexão e a lista
de vozes buscada do próprio servidor.

Aponte para um servidor de fala local (por exemplo `http://localhost:8010`), que
segue o padrão da OpenAI em `/v1/audio/speech` e `/v1/audio/transcriptions`.

A lista de vozes vem do próprio servidor assim que a seção abre — não é preciso clicar em
Testar. **Aparência da voz** escolhe como a Vela se mostra ao ouvir e falar, com preview ao vivo
de cada opção.

A última opção, **Seu shader**, é escrita por você: um editor de fragment shader com prévia ao
vivo ao lado, os uniforms de som e de estado já disponíveis (`uEnergy`, `uBass`, `uMood`, `uPace`
e companhia) e o erro do compilador apontando a linha certa do seu código. O que não compila não é
salvo, para o visual nunca sumir no painel sem explicação.

🔴 **Clique em "Permitir microfone" uma vez.** O runtime de voz roda num documento offscreen, e
documento offscreen **não consegue exibir o prompt de permissão** — sem essa liberação, feita na
página de opções, `getUserMedia` falha calado e o botão parece quebrado.

Servidor de fala em HTTP puro funciona sem mexer em nada: o `connect-src` do manifest libera
`https:`, `wss:` e também `http://*:*` — porque um servidor auto-hospedado na rede local quase nunca
tem certificado, e exigir que cada pessoa editasse o manifest para usar o próprio servidor seria
trocar uma inconveniência de segurança por uma barreira de uso. A extensão só fala com o endereço
que **você** configurou; a liberação do CSP não faz ela procurar ninguém.

A voz de fábrica é `piper:pt_BR-cadu-medium`. A escolha não é de timbre: o servidor devolve
quanto tempo leva para gerar em relação à duração do áudio, e o piper gera em **0,58×** o que
fala, contra **2,04×** da kokoro — acima de 1 a fala chega sempre atrasada, porque o servidor
perde para o relógio. Por isso a lista em Configurações → Voz vem ordenada da mais rápida para a
mais lenta, com o número ao lado, e quem já tinha uma voz lenta salva é migrado uma vez só.

**Síntese em streaming** (ligada) toca os pedaços de PCM à medida que chegam, agendados na linha
do tempo do AudioContext, em vez de esperar o arquivo inteiro.

**Texto ao vivo** mostra as palavras aparecendo enquanto você fala, no modo de voz ao vivo, em vez
de deixar a tela em branco até a frase acabar. É rascunho: vem do Vosk pelo WebSocket em
Configurações → Voz, muda enquanto você fala e **nunca vira comando** — quem decide o que a Vela
vai obedecer continua sendo a transcrição final. Por isso aparece esmaecido/em itálico enquanto é
só rascunho, e vira texto normal quando o final chega — sem essa distinção visual, um rascunho
errado (esperado, é o motor rápido) passava a impressão de que a transcrição inteira era ruim. Em
branco, o campo desliga o recurso e o resto da voz segue igual.

**Velocidade da fala** é um multiplicador aplicado no cliente (Configurações → Voz), porque o
servidor fala num ritmo fixo por voz e não tem parâmetro de taxa.

**Um modelo rápido para a primeira resposta.** Configurações → Providers → "Modelo rápido (Voz)"
faz o Live Voice responder com um modelo mais ágil na primeira rodada, e só troca para o modelo
padrão se a tarefa realmente precisar de ferramentas — que precisa suportar tool calling. Quando o
modelo rápido reconhece uma tarefa de várias etapas, ele pode delegá-la para rodar em segundo
plano com o modelo robusto (`delegate_task`, só disponível nessa situação): você continua a
conversa sem esperar, e o resultado chega falado quando termina. Duas tarefas em segundo plano ao mesmo tempo; as demais esperam em fila.

**Gravar uma sessão para depurar.** O botão vermelho no palco de voz liga o rastreio completo e, ao
parar, baixa o pacote de revisão da sessão inteira — relatório, eventos e áudios. Ver
[TRILHA.md](TRILHA.md).

**Ler uma mensagem em voz alta** é o botão de alto-falante em cada resposta. O orb fica pequeno no
alto — quem pede para ouvir quer continuar vendo o texto — e a palavra sendo falada **acende no
próprio texto**, com a frase em volta num véu. O destaque segue a cor da marca e o tema. Clicar de
novo para.

### O palco da voz

Ao entrar em Live Voice, o orb ocupa a conversa: durante uma fala o assunto é o que se ouve, não
o que está escrito. **Tocar no orb encolhe ele e o desce até o rodapé**, e a conversa reaparece —
é o mesmo componente nos dois tamanhos, então a transição é contínua em vez de uma troca de tela.
Debaixo dele ficam silenciar o microfone e encerrar.

A **janelinha flutuante na página** (o Pulse) nasce desligada, em Configurações → Voz. Ela é uma
segunda superfície por cima do site que você está lendo, e só faz sentido com a barra lateral
fechada — com o painel aberto, o palco já está lá.

## Voice Motion Lab

```bash
npm run ui   # depois abra http://127.0.0.1:5178/lab.html
```

Os cinco visuais de voz lado a lado, **recebendo exatamente o mesmo sinal ao mesmo tempo**,
alimentados pelo seu microfone de verdade. Existe para escolher a estética falando, em vez de
comparar screenshot — que é onde a decisão sempre travava.

| | Visual | Técnica |
|---|---|---|
| 01 | Ambient Edge | canvas 2D · gradiente radial + blend aditivo |
| 02 | Mesh Field | shader · focos gaussianos + domain warping |
| 03 | Soft Orb | shader · SDF de círculo + fBm na borda |
| 04 | Liquid Blob | shader · metaballs + smooth-min + domain warping |
| 05 | Energy Field | shader · fBm em cristas + domain warping |
| 00 | Orb atual | o que está no produto hoje, para comparação honesta |

A barra de cima troca a fonte do sinal (microfone, voz simulada ou parado) e o estado do agente,
e mostra `energy / bass / mid / high` ao vivo. "Isolar" abre um visual em tela maior.

A **voz simulada** produz rajadas com pausa: serve para conferir attack e release sem falar, e
para rodar onde não há microfone.
