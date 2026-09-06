/** Um toque curto quando a Vela precisa de você. Sintetizado, para não empacotar áudio
 *  nem depender de rede — e discreto o bastante para não assustar. */
export function playAttentionChime(kind: "approval" | "takeover" = "approval") {
  try {
    const context = new AudioContext();
    const now = context.currentTime;
    const notes = kind === "takeover" ? [660, 880] : [880, 1174];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const start = now + index * 0.11;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.05, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.24);
    });
    setTimeout(() => void context.close(), 700);
  } catch { /* aba sem permissão de áudio */ }
}
