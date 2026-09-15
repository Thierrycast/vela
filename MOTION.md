# Movimento e presença

O movimento da Vela é uma camada independente da UI. React controla estados macro; o renderer e
os controladores locais fazem o trabalho contínuo.

## Camadas

- `orb-renderer.ts` — renderer Canvas 2D com partículas determinísticas, órbita incompleta e
  deformação procedural. Estados: `idle`, `listening`, `thinking`, `speaking`, `acting`,
  `waiting`, `paused`, `error`, `complete`. É código sem framework, usado tanto pelo componente
  React do painel quanto pelo Pulse imperativo na página.
- `audio-metrics.ts` — análise Web Audio desacoplada. Faz noise gate, normalização, ataque/release
  e suavização de `energy`, `bass`, `mid`, `high` e `speaking`. Alimenta o orb.
- `vad.ts` — segmentação de fala por silêncio. Não alimenta o orb; decide onde um enunciado
  começa e termina.
- `cursor-motion.ts` — suavização exponencial (LERP) para o cursor virtual, mais a compressão do
  clique. Era mola com velocidade e amortecimento; produzia overshoot perto do alvo ("chacoalho").
  Sem estado de velocidade para carregar entre quadros, chega sem passar do ponto.
- `trace-layer.ts` — o Trace: cursor, alvo, ripple e borda de controle, em Shadow DOM. Um único
  `requestAnimationFrame` para todas as ações simultâneas.
- `pulse.ts` — o HUD flutuante, também em Shadow DOM, com o orb de canvas.
- `vela-components.tsx` — adaptador React do canvas e primitives que consomem só o estado macro.

## Regras de performance

1. Não atualizar estado React dentro do loop de renderização.
2. `requestAnimationFrame` só enquanto houver ação ativa; o loop para quando a última termina.
3. Recalcular o backing store do Canvas com limite de `devicePixelRatio` 2.
4. Publicar métricas de áudio a ~20 Hz (intervalo de 50 ms) e interpolar no renderer — nunca por
   frame.
5. Telemetria de voz vai só para a **aba ativa**, não para todas as abas.
6. Respeitar `prefers-reduced-motion`: o renderer desenha um frame estável e as animações CSS
   são desligadas.

## Estado de sessão × estado de ação

A borda de controle e a pílula "Vela está controlando" são estado de **sessão**: acendem quando a
execução começa e apagam quando termina. O destaque do alvo e o ripple são estado de **ação**:
vivem só o tempo daquele passo.

Isso importa porque criar e destruir a borda a cada ação produzia um piscar constante.

## Cursor fantasma

No modo Observar a ação é recusada, mas o cursor viaja até o alvo com traço tracejado e o alvo
pisca. O usuário vê o que a Vela *faria* sem que nada aconteça.

## Tokens

Tempos e curvas ficam em `motion-tokens.ts`. `motion.css` expõe os mesmos valores para transições
de entrada, troca de estado, loader, foco e presença.
