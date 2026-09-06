/** A marca da Vela, uma só. Antes existiam quatro desenhos diferentes: um anel em CSS na
 *  topbar, um ícone Radio do lucide nas opções, o orb em canvas e o PNG do manifest. */
export function VelaMark({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`vela-mark ${className}`} width={size} height={size} viewBox="0 0 128 128" fill="none" aria-hidden="true">
      <path d="M 100.7 47.6 A 40.3 40.3 0 1 0 80.6 73.1" stroke="currentColor" strokeWidth="8" strokeLinecap="round" />
      <path d="M 71.2 46.5 A 16.9 26.6 -28 1 0 76.4 76.8" stroke="currentColor" strokeWidth="5" strokeLinecap="round" opacity=".5" />
      <circle cx="100.7" cy="47.6" r="9.6" fill="currentColor" />
    </svg>
  );
}
