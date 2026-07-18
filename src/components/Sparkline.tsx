/**
 * Per-player price microtrend: single series with a soft area fill, 2px stroke,
 * no axes/legend (the row's name + price column label it). Stroke/fill color
 * encodes polarity — up/down vs. the first sample — and the numeric trend is
 * also in the row's Δ column, so color never carries the information alone.
 */
export function Sparkline({
  data,
  width = 120,
  height = 32,
}: {
  data: number[];
  width?: number;
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label="price history (not enough data yet)">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--border-strong)"
          strokeWidth={2}
          strokeDasharray="3 4"
        />
      </svg>
    );
  }
  const pad = 3;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const xy = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${(width - pad).toFixed(1)},${height - pad}`;

  const first = data[0];
  const last = data[data.length - 1];
  const flat = Math.abs(last - first) < 0.005;
  const color = flat ? "var(--ink-muted)" : last > first ? "var(--up)" : "var(--down)";
  const gradId = `spark-${first.toFixed(2)}-${last.toFixed(2)}-${data.length}`;
  const [lastX, lastY] = xy[xy.length - 1];

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`price history: ${first.toFixed(2)} to ${last.toFixed(2)}`}
    >
      <title>{`$${first.toFixed(2)} → $${last.toFixed(2)}`}</title>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {!flat && <polygon points={area} fill={`url(#${gradId})`} stroke="none" />}
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={2.6} fill={color} />
    </svg>
  );
}
