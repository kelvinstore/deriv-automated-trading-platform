import type { ReactNode } from "react";

/* ---------------------------------------------------------------- logo mark */
/** Hand-drawn sniper reticle + FV monogram. Scales to 16px, single colour. */
export function Mark({ size = 40, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Forex Vision Pros mark"
    >
      <defs>
        <clipPath id="fv-clip">
          <circle cx="32" cy="32" r="22" />
        </clipPath>
      </defs>
      {/* outer reticle ring with cardinal gaps */}
      <path
        d="M32 4.5A27.5 27.5 0 0 1 59.5 32 27.5 27.5 0 0 1 32 59.5 27.5 27.5 0 0 1 4.5 32 27.5 27.5 0 0 1 32 4.5Zm0 5.2A22.3 22.3 0 0 0 9.7 32 22.3 22.3 0 0 0 32 54.3 22.3 22.3 0 0 0 54.3 32 22.3 22.3 0 0 0 32 9.7Z"
        fill="currentColor"
        opacity="0.55"
      />
      {/* crosshair ticks */}
      <path
        d="M32 0.5h3.2v9.2H32zM32 54.3h3.2v9.2H32zM0.5 28.3h9.2v3.2H0.5zM54.3 28.3h9.2v3.2H54.3z"
        fill="currentColor"
      />
      {/* reticle arcs */}
      <path
        d="M32 14.8c9.5 0 17.2 7.7 17.2 17.2h-3.4c0-7.6-6.2-13.8-13.8-13.8Z"
        fill="currentColor"
        opacity="0.4"
      />
      <path
        d="M32 49.2c-9.5 0-17.2-7.7-17.2-17.2h3.4c0 7.6 6.2 13.8 13.8 13.8Z"
        fill="currentColor"
        opacity="0.4"
      />
      {/* F monogram */}
      <path d="M18.4 22.6h12.2v3.5h-8.4v3.9h7.2v3.5h-7.2v5.4h-3.8z" fill="currentColor" />
      {/* V monogram */}
      <path d="M32.9 22.6h3.9l2.6 9.9 2.6-9.9h3.8l-4.6 16.3h-3.8z" fill="currentColor" />
      {/* centre dot */}
      <circle cx="32" cy="32" r="1.5" fill="currentColor" />
      <g clipPath="url(#fv-clip)" />
    </svg>
  );
}

/* ------------------------------------------------------------------- gauge */
export function ConfidenceGauge({ value, tone }: { value: number; tone: "BUY" | "SELL" | "WAIT" }) {
  const pct = Math.max(0, Math.min(100, value)) / 100;
  const len = Math.PI * 90;
  const colour = tone === "BUY" ? "#2bd98a" : tone === "SELL" ? "#ff5a5a" : "#f5a524";
  return (
    <svg viewBox="0 0 200 116" className="w-full max-w-[320px]" role="img" aria-label={`Confidence ${value}%`}>
      <path d="M 10 100 A 90 90 0 0 1 190 100" fill="none" stroke="#1e2a32" strokeWidth="13" strokeLinecap="round" />
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const a = Math.PI * (1 - t);
        const x1 = 100 + Math.cos(a) * 72;
        const y1 = 100 - Math.sin(a) * 72;
        const x2 = 100 + Math.cos(a) * 80;
        const y2 = 100 - Math.sin(a) * 80;
        return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#2c3b44" strokeWidth="1.5" />;
      })}
      <path
        d="M 10 100 A 90 90 0 0 1 190 100"
        fill="none"
        stroke={colour}
        strokeWidth="13"
        strokeLinecap="round"
        strokeDasharray={`${len * pct} ${len}`}
        style={{ transition: "stroke-dasharray 420ms cubic-bezier(.2,.7,.3,1), stroke 220ms" }}
      />
      <text
        x="100"
        y="88"
        textAnchor="middle"
        fill="#e8f1f4"
        fontFamily="'IBM Plex Mono', monospace"
        fontSize="34"
        fontWeight="600"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {Math.round(value)}
      </text>
      <text
        x="100"
        y="108"
        textAnchor="middle"
        fill="#7e9099"
        fontFamily="'Chakra Petch', sans-serif"
        fontSize="10"
        letterSpacing="3"
      >
        CONFIDENCE %
      </text>
    </svg>
  );
}

/* --------------------------------------------------------------- sparkline */
export function Sparkline({ points, tone }: { points: number[]; tone: string }) {
  if (points.length < 2) {
    return (
      <div className="h-[64px] grid place-items-center text-[11px] legend legend-muted">
        AWAITING DERIV TICK STREAM
      </div>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const w = 600;
  const h = 64;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / span) * (h - 8) - 4;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `${d} L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-[64px]" role="img" aria-label="Live Deriv tick stream">
      <path d={area} fill={tone} opacity="0.09" />
      <path d={d} fill="none" stroke={tone} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ------------------------------------------------------------- candle chart */
export interface ChartCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** SVG candlestick chart drawn from real Deriv candles, with EMA20/EMA50 overlays. */
export function CandleChart({ candles, limit = 70 }: { candles: ChartCandle[]; limit?: number }) {
  const slice = candles.slice(-limit);
  if (slice.length < 3) {
    return (
      <div className="h-[190px] grid place-items-center text-[11px] legend legend-muted border border-[var(--hairline)]">
        AWAITING DERIV CANDLE HISTORY
      </div>
    );
  }

  const w = 1000;
  const h = 210;
  const padY = 14;
  const highs = slice.map((c) => c.high);
  const lows = slice.map((c) => c.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const span = max - min || 1;
  const y = (v: number) => padY + (1 - (v - min) / span) * (h - padY * 2);
  const step = w / slice.length;
  const body = Math.max(2.2, step * 0.58);

  const emaSeries = (values: number[], period: number) => {
    const k = 2 / (period + 1);
    let prev = values[0];
    return values.map((v, i) => (i === 0 ? (prev = v) : (prev = v * k + prev * (1 - k))));
  };
  const closes = slice.map((c) => c.close);
  const e20 = emaSeries(closes, Math.min(20, closes.length));
  const e50 = emaSeries(closes, Math.min(50, closes.length));
  const line = (series: number[]) =>
    series.map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step + step / 2).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-[190px]" role="img" aria-label="Deriv candles">
      {[0.25, 0.5, 0.75].map((t) => (
        <line key={t} x1={0} y1={padY + t * (h - padY * 2)} x2={w} y2={padY + t * (h - padY * 2)} stroke="#1b252c" strokeWidth="1" />
      ))}
      {slice.map((c, i) => {
        const x = i * step + step / 2;
        const up = c.close >= c.open;
        const col = up ? "#2bd98a" : "#ff5a5a";
        const top = y(Math.max(c.open, c.close));
        const bottom = y(Math.min(c.open, c.close));
        return (
          <g key={c.epoch}>
            <line x1={x} y1={y(c.high)} x2={x} y2={y(c.low)} stroke={col} strokeWidth="1" opacity="0.85" />
            <rect x={x - body / 2} y={top} width={body} height={Math.max(1, bottom - top)} fill={col} opacity={up ? 0.9 : 0.85} />
          </g>
        );
      })}
      <path d={line(e50)} fill="none" stroke="#5c7f8f" strokeWidth="1.6" vectorEffect="non-scaling-stroke" opacity="0.85" />
      <path d={line(e20)} fill="none" stroke="#f5a524" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* --------------------------------------------------------------- fragments */
export function Legend({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <div className={`legend ${muted ? "legend-muted" : ""}`}>{children}</div>;
}

export function Readout({
  label,
  value,
  sub,
  tone,
  flash,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
  flash?: boolean;
}) {
  return (
    <div className={`readout ${flash ? "tick-flash" : ""}`} key={String(value)}>
      <div className="legend legend-muted">{label}</div>
      <div className="readout-value" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {sub ? <div className="text-[10.5px] text-[var(--muted)] num mt-[2px]">{sub}</div> : null}
    </div>
  );
}

export function Band({
  id,
  title,
  index,
  right,
  children,
  texture = false,
}: {
  id?: string;
  title: string;
  index: string;
  right?: ReactNode;
  children: ReactNode;
  texture?: boolean;
}) {
  return (
    <section id={id} className={`band ${texture ? "grain" : ""}`}>
      {texture ? (
        <div
          className="absolute inset-0 opacity-[0.16] texture"
          style={{ maskImage: "linear-gradient(180deg, rgba(0,0,0,.9), transparent)" }}
          aria-hidden
        />
      ) : null}
      <div className="band-inner relative">
        <header className="flex items-end justify-between gap-4 mb-4">
          <div className="gutter-rule">
            <div className="legend legend-muted">{index}</div>
            <h2 className="text-[15px] sm:text-[17px] leading-tight">{title}</h2>
          </div>
          {right ? <div className="flex items-center gap-2 flex-wrap justify-end">{right}</div> : null}
        </header>
        {children}
      </div>
    </section>
  );
}
