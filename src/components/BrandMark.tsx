/**
 * Ticker logo mark: a rounded gradient tile with an upward candlestick /
 * pulse line. Sport-neutral so it works as the brand scales past soccer.
 */
export function BrandMark({ size = 34 }: { size?: number }) {
  const inner = Math.round(size * 0.62);
  return (
    <span className="mark" style={{ width: size, height: size }}>
      <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M3 15.5 L8.5 10 L12.5 13.5 L21 5"
          stroke="#0a0b0f"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16 5 H21 V10"
          stroke="#0a0b0f"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
