/**
 * Per-player price microtrend: single series, 2px stroke, no axes/legend
 * (the row's name + price column label it). Stroke color encodes polarity —
 * up/down vs. the first sample — and the numeric trend is also in the row's
 * Δ column, so color never carries the information alone.
 */
export function Sparkline({
  data,
  width = 110,
  height = 30,
}: {
  data: number[];
  width?: number;
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label="price history (not enough data yet)">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="var(--baseline)" strokeWidth={2} strokeDasharray="3 4" />
      </svg>
    );
  }
  const pad = 2;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const points = data
    .map((v, i) => {
      const x = pad + (i / (data.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (v - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const first = data[0];
  const last = data[data.length - 1];
  const color =
    Math.abs(last - first) < 0.005 ? "var(--ink-muted)" : last > first ? "var(--up)" : "var(--down)";
  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`price history: ${first.toFixed(2)} to ${last.toFixed(2)}`}
    >
      <title>{`$${first.toFixed(2)} → $${last.toFixed(2)}`}</title>
      <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle
        cx={pad + (width - pad * 2)}
        cy={pad + (1 - (last - min) / span) * (height - pad * 2)}
        r={2.5}
        fill={color}
      />
    </svg>
  );
}
