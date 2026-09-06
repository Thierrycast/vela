/** A marca da Vela, uma só. Antes existiam quatro desenhos diferentes: um anel em CSS na
 *  topbar, um ícone Radio do lucide nas opções, o orb em canvas e o PNG do manifest. */
export function VelaMark({ size = 18, className = "" }: { size?: number; className?: string }) {
  // Abaixo de 22px o arco interno vira borrão em vez de detalhe: some, e sobra a órbita e o ponto.
  const detailed = size >= 22;
  return (
    <svg className={`vela-mark ${className}`} width={size} height={size} viewBox="0 0 128 128" fill="none" aria-hidden="true" shapeRendering="geometricPrecision">
      <path d="M 100.7 47.6 A 40.3 40.3 0 1 0 80.6 73.1" stroke="currentColor" strokeWidth={detailed ? 8 : 9.5} strokeLinecap="round" />
      {detailed && <path d="M 71.2 46.5 A 16.9 26.6 -28 1 0 76.4 76.8" stroke="currentColor" strokeWidth="5" strokeLinecap="round" opacity=".45" />}
      <circle cx="100.7" cy="47.6" r={detailed ? 9.6 : 11} fill="currentColor" />
    </svg>
  );
}
