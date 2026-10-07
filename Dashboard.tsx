"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContractState, EngineState, LogEntry, PreflightItem } from "@/lib/engine";
import { DERIV_SYMBOLS, TIMEFRAMES, type RiskConfig } from "@/lib/config";
import { Band, CandleChart, ConfidenceGauge, Mark, Readout, Sparkline } from "./ui";

interface TradeRow {
  id: number;
  createdAt: string;
  settledAt: string | null;
  accountType: string;
  loginid: string | null;
  currency: string | null;
  symbol: string;
  timeframe: number;
  direction: string;
  contractType: string;
  contractId: number | null;
  stake: number;
  payout: number | null;
  buyPrice: number | null;
  entrySpot: number | null;
  exitSpot: number | null;
  profit: number | null;
  status: string;
  confidence: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi: number | null;
  adx: number | null;
  momentum: number | null;
  atr: number | null;
  entryReason: string | null;
  exitReason: string | null;
}

const CONFIRM_PHRASE = "CONFIRM REAL TRADING";

const fmt = (v: number | null | undefined, d = 5) =>
  typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

const money = (v: number | null | undefined, currency = "USD") =>
  typeof v === "number" && Number.isFinite(v)
    ? `${v < 0 ? "−" : ""}${currency === "USD" ? "$" : ""}${Math.abs(v).toFixed(2)}${currency && currency !== "USD" ? ` ${currency}` : ""}`
    : "—";

const timeStr = (ts: number | string | null | undefined) => {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour12: false });
};

export default function Dashboard() {
  const [state, setState] = useState<EngineState | null>(null);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [symbolInput, setSymbolInput] = useState("1HZ75V");
  const [timeframe, setTimeframe] = useState(1);
  const [confirmText, setConfirmText] = useState("");
  const [tokenMode, setTokenMode] = useState<"demo" | "real">("demo");
  const [tokenValue, setTokenValue] = useState("");
  const [riskDraft, setRiskDraft] = useState<RiskConfig | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [bootStalled, setBootStalled] = useState(false);
  const lastPrice = useRef<number | null>(null);

  /* ---------------------------------------------------------- state stream */
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; state: EngineState };
        if (msg.type === "state") {
          setState(msg.state);
          setRiskDraft((prev) => prev ?? msg.state.risk);
          if (msg.state.market.symbol !== symbolInput) setSymbolInput(msg.state.market.symbol);
          setTimeframe(msg.state.market.timeframe);
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // If the SSE stream has not delivered a frame, surface it instead of spinning forever.
  useEffect(() => {
    if (state) return;
    const t = setTimeout(() => setBootStalled(true), 6000);
    return () => clearTimeout(t);
  }, [state]);

  const loadTrades = useCallback(async () => {
    try {
      const res = await fetch("/api/trades?limit=80");
      const json = (await res.json()) as { rows: TradeRow[] };
      setTrades(json.rows ?? []);
    } catch {
      /* keep previous rows */
    }
  }, []);

  useEffect(() => {
    void loadTrades();
  }, [loadTrades, state?.stats.totalTrades]);

  const send = useCallback(
    async (body: Record<string, unknown>, label: string) => {
      setBusy(label);
      try {
        const res = await fetch("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as { ok: boolean; reason?: string; state?: EngineState };
        if (json.state) setState(json.state);
        setNotice(
          json.ok
            ? { tone: "ok", text: `${label} — command accepted` }
            : { tone: "bad", text: `${label} — ${json.reason ?? "command rejected"}` },
        );
        if (body.action === "preflight" || body.action === "switchAccount") void loadTrades();
        return json;
      } catch (err) {
        setNotice({ tone: "bad", text: `${label} — ${err instanceof Error ? err.message : "request failed"}` });
        return { ok: false, reason: "request failed" };
      } finally {
        setBusy(null);
      }
    },
    [loadTrades],
  );

  if (!state) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <div className="text-center max-w-[520px]">
          <Mark size={56} className="text-[var(--amber)] mx-auto" />
          <div className="legend mt-4">ESTABLISHING DERIV WEBSOCKET LINK</div>
          <div className="text-[var(--muted)] text-[12px] mt-2 num">authorize · ticks_history · balance · portfolio</div>
          {bootStalled ? (
            <>
              <div className="mt-5 plate p-4 text-left">
                <div className="legend text-[var(--amber)]">TELEMETRY STREAM DELAYED</div>
                <div className="text-[11.5px] num text-[var(--muted)] mt-2">
                  The server has not published an engine snapshot yet. The terminal never fabricates market data — if the
                  Deriv WebSocket cannot be reached from this host, the dashboard will report{" "}
                  <span className="text-[var(--ink)]">WAIT</span> and block all trading.
                </div>
              </div>
              <button className="btn btn-amber mt-4" onClick={() => window.location.reload()}>
                ↻ RELOAD TERMINAL
              </button>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  const ev = state.evaluation;
  const signal = ev?.signal ?? "WAIT";
  const toneClass = signal === "BUY" ? "t-buy" : signal === "SELL" ? "t-sell" : "t-wait";
  const toneColour = signal === "BUY" ? "#2bd98a" : signal === "SELL" ? "#ff5a5a" : "#f5a524";
  const isReal = state.accountMode === "real";
  const accountBadge = isReal ? "REAL — LIVE DERIV API" : "DEMO — LIVE DERIV API";
  const accountCaption = isReal
    ? "Live Deriv market + real API execution + real funds"
    : "Live Deriv market + real API execution + virtual demo funds";
  const c: ContractState | null = state.openContract;
  const elapsed = c?.startTime ? Math.max(0, Math.floor((now / 1000 - c.startTime))) : 0;
  const priceMoved = lastPrice.current !== state.market.price;
  lastPrice.current = state.market.price;

  const scoreRows = ev
    ? [
        { label: "EMA TREND", weight: 30, score: ev.scores.ema },
        { label: "ADX", weight: 20, score: ev.scores.adx },
        { label: "RSI", weight: 20, score: ev.scores.rsi },
        { label: "MOMENTUM", weight: 15, score: ev.scores.momentum },
        { label: "PRICE STRUCTURE", weight: 15, score: ev.scores.price },
      ]
    : [];

  return (
    <div className="pb-24">
      {/* ============================================================ HEADER */}
      <header className="relative overflow-hidden border-b border-[var(--hairline)]">
        <div className="absolute inset-0 texture opacity-[0.22]" aria-hidden />
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(115deg, rgba(11,16,20,.94) 20%, rgba(11,16,20,.62) 65%, rgba(245,165,36,.12))" }}
          aria-hidden
        />
        <div className="band-inner relative px-4 pt-6 pb-7">
          <div className="flex flex-wrap items-start gap-4 justify-between">
            <div className="flex items-center gap-3">
              <Mark size={46} className="text-[var(--amber)]" />
              <div>
                <div className="legend">FOREX VISION PROS</div>
                <h1 className="text-[22px] sm:text-[30px] leading-[0.95] tracking-tight">
                  DERIV SNIPER <span className="text-[var(--amber)]">AI</span>
                </h1>
              </div>
            </div>
            <div className="flex flex-col items-start sm:items-end gap-2">
              <div className={`pill ${isReal ? "pill-danger" : "pill-live"}`}>
                <span className="dot" />
                {accountBadge}
              </div>
              <div className="text-[11px] text-[var(--muted)] num">{accountCaption}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mt-5">
            <span className={`pill ${state.connection.status === "ready" ? "pill-live" : "pill-warn"}`}>
              <span className="dot" />
              DERIV {state.connection.status.toUpperCase()}
            </span>
            <span className="pill">{state.account?.loginid ?? "NO ACCOUNT"}</span>
            <span className="pill">BAL {money(state.account?.balance, state.account?.currency ?? "USD")}</span>
            <span className={`pill ${state.autoTrading ? "pill-live" : "pill-warn"}`}>
              AUTO {state.autoTrading ? "ON" : "OFF"}
            </span>
            <span className="pill">{state.market.symbol}</span>
            <span className="pill">{state.market.timeframe} MIN</span>
            <span className="pill">PX {fmt(state.market.price, 5)}</span>
            <span className={`pill ${signal === "WAIT" ? "pill-warn" : signal === "BUY" ? "pill-live" : "pill-danger"}`}>
              {signal} · {ev?.confidence ?? 0}%
            </span>
          </div>
          <div className="text-[11px] text-[var(--muted)] num mt-3">
            {state.autoStatus}
          </div>
        </div>
      </header>

      {/* ==================================================== COCKPIT STRIP */}
      <div className="sticky-strip">
        <div className="band-inner px-4 py-3">
          <div className="scroll-x">
            <Readout
              label="DERIV CONNECTION"
              value={state.connection.status === "ready" ? "CONNECTED" : state.connection.status.toUpperCase()}
              sub={`app_id ${state.connection.appId} · reconnects ${state.connection.reconnects}`}
              tone={state.connection.status === "ready" ? "#2bd98a" : "#f5a524"}
            />
            <Readout
              label="ACCOUNT"
              value={isReal ? "REAL" : "DEMO"}
              sub={`${state.account?.currency ?? "—"} · ${state.account?.loginid ?? "unauthenticated"}`}
              tone={isReal ? "#ff5a5a" : "#2bd98a"}
            />
            <Readout
              label="BALANCE"
              value={money(state.account?.balance, state.account?.currency ?? "USD")}
              sub={`available ${money(state.account?.available ?? state.account?.balance, state.account?.currency ?? "USD")}`}
            />
            <Readout
              label="AUTO TRADING"
              value={state.autoTrading ? "ON" : "OFF"}
              sub={state.autoTrading ? "real Deriv execution" : "no new entries"}
              tone={state.autoTrading ? "#2bd98a" : "#f5a524"}
            />
            <Readout label="MARKET" value={state.market.symbol} sub={state.market.symbolName} />
            <Readout label="TIMEFRAME" value={`${state.market.timeframe} MIN`} sub={`granularity ${state.market.granularity}s`} />
            <Readout
              label="CURRENT PRICE"
              value={fmt(state.market.price, 5)}
              sub={state.market.status}
              flash={priceMoved}
            />
            <Readout label="SIGNAL" value={signal} sub={ev?.entryReason?.slice(0, 42) ?? "evaluating"} tone={toneColour} />
            <Readout label="CONFIDENCE" value={`${ev?.confidence ?? 0}%`} sub={`threshold ${state.risk.confidenceThreshold}%`} tone={toneColour} />
          </div>
        </div>
      </div>

      {/* ============================================= CONNECTION ADVISORY */}
      {state.connection.status !== "ready" ? (
        <div className="band" style={{ background: "linear-gradient(180deg, rgba(245,165,36,.10), rgba(11,16,20,0))" }}>
          <div className="band-inner">
            <div className="plate p-4 sm:p-5">
              <div className="flex flex-wrap items-start gap-4 justify-between">
                <div className="gutter-rule">
                  <div className="legend text-[var(--amber)]">DERIV LINK NOT ESTABLISHED</div>
                  <h3 className="text-[15px] mt-1">
                    {state.connection.status === "reconnecting"
                      ? "RECONNECTING TO THE DERIV WEBSOCKET"
                      : state.connection.status === "error"
                        ? "DERIV WEBSOCKET ERROR"
                        : "ESTABLISHING DERIV WEBSOCKET LINK"}
                  </h3>
                  <div className="text-[11.5px] num text-[var(--muted)] mt-2 max-w-[720px]">
                    Status: <span className="text-[var(--ink)]">{state.connection.status}</span> ·{" "}
                    <span className="text-[var(--ink)]">{state.connection.detail || "no detail"}</span>
                    <br />
                    Until the official Deriv WebSocket (<span className="text-[var(--ink)]">wss://ws.derivws.com/websockets/v3</span>)
                    answers, this terminal reports <span className="text-[var(--amber)]">WAIT</span> and refuses to send any
                    proposal or buy request. Nothing on this page is simulated to look live.
                  </div>
                  <div className="text-[11px] num text-[var(--muted)] mt-2">
                    Checklist — outbound WebSocket access to Deriv · valid <span className="text-[var(--ink)]">DERIV_APP_ID</span> ·
                    API token for the selected account (store it in Section 05 or set{" "}
                    <span className="text-[var(--ink)]">DERIV_API_TOKEN_DEMO / _REAL</span>) · reconnect attempts{" "}
                    <span className="text-[var(--ink)]">{state.connection.reconnects}</span>
                  </div>
                </div>
                <button className="btn btn-amber" disabled={busy !== null} onClick={() => void send({ action: "reconnect" }, "RECONNECT")}>
                  ↻ RETRY DERIV CONNECTION
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ============================================================ SIGNAL */}
      <Band
        index="SECTION 01"
        title="DERIV SNIPER AI — WEIGHTED CONFIRMATION"
        texture
        right={
          <>
            <span className="pill">EMA 30 · ADX 20 · RSI 20 · MOM 15 · PRICE 15</span>
            <span className={`pill ${state.synced ? "pill-live" : "pill-warn"}`}>
              <span className="dot" />
              {state.synced ? "SYNCHRONIZED" : "NOT SYNCHRONIZED"}
            </span>
          </>
        }
      >
        <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="plate p-5 relative overflow-hidden">
            {state.autoTrading ? <div className="scan" aria-hidden /> : null}
            <div className="legend legend-muted">SIGNAL ON CLOSED DERIV CANDLE</div>
            <div className={`signal-word ${toneClass} mt-2`}>{signal}</div>
            <div className="text-[15px] sm:text-[19px] num mt-2" style={{ color: toneColour }}>
              {signal} — {ev?.confidence ?? 0}% CONFIDENCE
            </div>
            <div className="text-[11.5px] text-[var(--muted)] num mt-1">
              evaluated on {state.candles.length} closed Deriv candles · {state.market.symbol} · {state.market.timeframe} min
            </div>

            <div
              className={`mt-4 px-3 py-2 border text-[11px] num ${
                signal !== "WAIT"
                  ? "border-[rgba(43,217,138,.4)] bg-[rgba(43,217,138,.08)] text-[var(--buy)]"
                  : "border-[rgba(245,165,36,.35)] bg-[rgba(245,165,36,.07)] text-[var(--amber)]"
              }`}
            >
              {signal === "WAIT"
                ? "WAITING — conditions not satisfied, no proposal is sent"
                : state.autoTrading
                  ? "EXECUTION APPROVED — Deriv proposal → validate → buy"
                  : "EXECUTION APPROVED — automation is OFF, no order will be sent"}
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="legend legend-muted mb-2">BLOCKERS</div>
                {(ev?.blockers ?? []).length === 0 ? (
                  <div className="text-[11.5px] text-[var(--buy)] num">✓ no blockers — all conditions satisfied</div>
                ) : (
                  (ev?.blockers ?? []).slice(0, 8).map((b) => (
                    <div key={b} className="check-row">
                      <span className="check-mark check-no">!</span>
                      <span className="text-[var(--ink)] num">{b.replace(/^WAIT — /, "")}</span>
                    </div>
                  ))
                )}
              </div>
              <div>
                <div className="legend legend-muted mb-2">CONFIRMATIONS</div>
                {(ev?.reasons ?? []).length === 0 ? (
                  <div className="text-[11.5px] text-[var(--muted)] num">no confirmations yet</div>
                ) : (
                  (ev?.reasons ?? []).slice(0, 8).map((r) => (
                    <div key={r} className="check-row">
                      <span className="check-mark check-ok">✓</span>
                      <span className="text-[var(--ink)] num">{r.replace(/^✓ /, "")}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="plate p-5">
            <div className="legend legend-muted">CONFIDENCE MODEL</div>
            <div className="flex justify-center mt-1">
              <ConfidenceGauge value={ev?.confidence ?? 0} tone={signal} />
            </div>
            <div className="mt-3 space-y-2">
              {scoreRows.map((row) => (
                <div key={row.label}>
                  <div className="flex justify-between text-[10px] legend legend-muted">
                    <span>{row.label}</span>
                    <span className="num">
                      {row.score} / {row.weight}
                    </span>
                  </div>
                  <div className="h-[6px] bg-[#1b252c] rounded-[1px] overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${Math.min(100, (row.score / row.weight) * 100)}%`,
                        background: toneColour,
                        transition: "width 380ms cubic-bezier(.2,.7,.3,1)",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="hairline my-4" />
            <div className="legend legend-muted mb-2">TEN CONDITION CHECKLIST</div>
            <div className="max-h-[280px] overflow-y-auto pr-1">
              {(ev?.checks ?? []).map((chk) => (
                <div key={chk.key} className="check-row">
                  <span className={`check-mark ${chk.ok ? "check-ok" : "check-no"}`}>{chk.ok ? "✓" : "✗"}</span>
                  <span>
                    <span className="text-[var(--ink-strong)] num">{chk.label}</span>
                    <br />
                    <span className="text-[var(--muted)] num text-[10.5px]">{chk.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Band>

      {/* ============================================================ MARKET */}
      <Band
        index="SECTION 02"
        title="LIVE DERIV MARKET + INDICATOR LEDGER"
        right={<span className="pill">{state.market.status}</span>}
      >
        <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="plate p-5">
            <div className="legend legend-muted">MARKET SELECTOR — SYMBOL SENT TO DERIV VERBATIM</div>
            <div className="grid gap-3 sm:grid-cols-2 mt-3">
              <div>
                <label className="legend legend-muted block mb-1" htmlFor="symbol">
                  DERIV SYMBOL
                </label>
                <input
                  id="symbol"
                  className="field num uppercase"
                  list="symbol-list"
                  value={symbolInput}
                  onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
                />
                <datalist id="symbol-list">
                  {DERIV_SYMBOLS.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name}
                    </option>
                  ))}
                </datalist>
              </div>
              <div>
                <label className="legend legend-muted block mb-1" htmlFor="tf">
                  TIMEFRAME
                </label>
                <select
                  id="tf"
                  className="field num"
                  value={timeframe}
                  onChange={(e) => setTimeframe(Number(e.target.value))}
                >
                  {TIMEFRAMES.map((t) => (
                    <option key={t.minutes} value={t.minutes}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              className="btn btn-amber w-full mt-3"
              disabled={busy !== null}
              onClick={() => void send({ action: "setMarket", symbol: symbolInput, timeframe }, "MARKET")}
            >
              {busy === "MARKET" ? "SUBSCRIBING…" : "APPLY TO DERIV STREAMS"}
            </button>

            <div className="grid grid-cols-2 gap-3 mt-4">
              <Readout label="CURRENT PRICE" value={fmt(state.market.price, 5)} flash={priceMoved} />
              <Readout
                label="BID / ASK"
                value={`${state.lastProposal ? fmt(state.lastProposal.askPrice, 2) : "—"}`}
                sub={state.lastProposal ? `Deriv proposal ask · ${state.lastProposal.contractType}` : "no live Deriv proposal"}
              />
              <Readout
                label="CURRENT CANDLE"
                value={fmt(state.currentCandle?.close, 5)}
                sub={
                  state.currentCandle
                    ? `O ${fmt(state.currentCandle.open, 5)} · H ${fmt(state.currentCandle.high, 5)} · L ${fmt(state.currentCandle.low, 5)}`
                    : "awaiting ohlc stream"
                }
              />
              <Readout
                label="PREVIOUS CLOSED CANDLE"
                value={fmt(state.previousCandle?.close, 5)}
                sub={
                  state.previousCandle
                    ? `${state.previousCandle.close >= state.previousCandle.open ? "▲ bullish" : "▼ bearish"} · O ${fmt(state.previousCandle.open, 5)} · C ${fmt(state.previousCandle.close, 5)}`
                    : "awaiting ohlc stream"
                }
              />
            </div>

            <div className="mt-4">
              <div className="legend legend-muted mb-1">LIVE DERIV TICK STREAM</div>
              <Sparkline points={state.market.ticks.map((t) => t.quote)} tone={toneColour} />
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between">
                <div className="legend legend-muted mb-1">
                  DERIV CANDLES · {state.market.granularity}s · CLOSED + FORMING
                </div>
                <div className="flex gap-3 text-[9.5px] legend">
                  <span className="text-[var(--amber)]">— EMA 20</span>
                  <span style={{ color: "#5c7f8f" }}>— EMA 50</span>
                </div>
              </div>
              <CandleChart candles={state.candles} />
            </div>
          </div>

          <div className="plate p-5">
            <div className="flex items-center justify-between">
              <div className="legend legend-muted">INDICATORS — CALCULATED FROM ACTUAL DERIV CANDLES</div>
              <span className="pill">EMA 20/50/200 · RSI 14 · ADX 14 · MOM 14 · ATR 14</span>
            </div>
            <div className="table-wrap mt-3">
              <table className="data">
                <thead>
                  <tr>
                    <th>Indicator</th>
                    <th>Value</th>
                    <th>Reading</th>
                    <th>Condition</th>
                  </tr>
                </thead>
                <tbody>
                  <IndicatorRow name="EMA 20" value={fmt(state.indicators.ema20, 5)} reading="fast trend" ok={ev?.checks.find((c) => c.key === "ema_cross")?.ok ?? false} />
                  <IndicatorRow name="EMA 50" value={fmt(state.indicators.ema50, 5)} reading="medium trend" ok={ev?.checks.find((c) => c.key === "ema_trend")?.ok ?? false} />
                  <IndicatorRow name="EMA 200" value={fmt(state.indicators.ema200, 5)} reading="primary trend" ok={ev?.checks.find((c) => c.key === "ema_trend")?.ok ?? false} />
                  <IndicatorRow name="RSI 14" value={fmt(state.indicators.rsi14, 2)} reading="momentum oscillator" ok={ev?.checks.find((c) => c.key === "rsi")?.ok ?? false} />
                  <IndicatorRow name="ADX 14" value={fmt(state.indicators.adx14, 2)} reading={`+DI ${fmt(state.indicators.diPlus, 2)} · −DI ${fmt(state.indicators.diMinus, 2)}`} ok={ev?.checks.find((c) => c.key === "adx")?.ok ?? false} />
                  <IndicatorRow name="Momentum 14" value={fmt(state.indicators.momentum14, 4)} reading="close / close[14] × 100" ok={ev?.checks.find((c) => c.key === "momentum")?.ok ?? false} />
                  <IndicatorRow name="ATR 14" value={fmt(state.indicators.atr14, 5)} reading={`${fmt(state.indicators.atrPercent, 4)}% of price · median ${fmt(state.indicators.atrMedian, 5)}`} ok={ev?.checks.find((c) => c.key === "atr")?.ok ?? false} />
                  <IndicatorRow name="Market status" value={state.market.status} reading={`${state.market.lastTickAt ? `last tick ${timeStr(state.market.lastTickAt)}` : "no ticks"}`} ok={state.market.lastTickAt !== null} />
                </tbody>
              </table>
            </div>
            <div className="text-[10.5px] text-[var(--muted)] num mt-3">
              Signals are produced only from CLOSED candles. The forming candle never triggers an entry. No generated, random
              or hardcoded price data exists anywhere in this system.
            </div>
          </div>
        </div>
      </Band>

      {/* ==================================================== OPEN CONTRACT */}
      <Band
        index="SECTION 03"
        title="OPEN DERIV CONTRACT — LIVE FROM proposal_open_contract"
        right={
          c ? (
            <span className={`pill ${c.isSold ? "pill-warn" : "pill-live"}`}>
              <span className="dot" />
              {c.status.toUpperCase()}
            </span>
          ) : (
            <span className="pill pill-warn">NO OPEN CONTRACT</span>
          )
        }
      >
        {c ? (
          <div className="plate p-5 stamped" key={c.contractId}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="legend legend-muted">CONTRACT ID</div>
                <div className="num text-[26px] sm:text-[34px] leading-none text-[var(--amber)]">{c.contractId}</div>
                <div className="text-[11px] text-[var(--muted)] num mt-1">{c.entryReason}</div>
              </div>
              <div className="text-right">
                <div className="legend legend-muted">CURRENT P/L (DERIV)</div>
                <div
                  className="num text-[26px] sm:text-[34px] leading-none"
                  style={{ color: (c.profit ?? 0) >= 0 ? "#2bd98a" : "#ff5a5a" }}
                >
                  {money(c.profit ?? 0, c.currency)}
                </div>
                <div className="text-[11px] text-[var(--muted)] num mt-1">
                  elapsed {Math.floor(elapsed / 60)}m {elapsed % 60}s
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
              <Readout label="SYMBOL" value={c.symbol} sub={c.contractType} />
              <Readout label="DIRECTION" value={c.direction} tone={c.direction === "BUY" ? "#2bd98a" : "#ff5a5a"} />
              <Readout label="ENTRY SPOT" value={fmt(c.entrySpot, 5)} sub="Deriv entry tick" />
              <Readout label="CURRENT SPOT" value={fmt(c.currentSpot, 5)} sub="Deriv current spot" />
              <Readout label="STAKE (BUY PRICE)" value={money(c.buyPrice, c.currency)} />
              <Readout label="POTENTIAL PAYOUT" value={money(c.payout, c.currency)} />
              <Readout label="ACCOUNT" value={c.accountType.toUpperCase()} sub={c.currency} />
              <Readout label="STATUS" value={c.status.toUpperCase()} sub={c.isSold ? "settled by Deriv" : "open"} />
            </div>
            {c.exitReason ? (
              <div className="mt-4 px-3 py-2 border border-[var(--hairline)] text-[11px] num text-[var(--ink)]">
                {c.exitReason}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="plate p-5">
            <div className="legend legend-muted">NO POSITION</div>
            <div className="text-[12px] text-[var(--muted)] num mt-2">
              No Deriv contract is currently open on the authenticated account. The engine will only open a contract after a
              real Deriv <span className="text-[var(--amber)]">buy</span> response returns a contract_id — nothing is recorded
              before that.
            </div>
            {state.closedContract ? (
              <div className="mt-4 gutter-rule">
                <div className="legend legend-muted">LAST SETTLED DERIV CONTRACT</div>
                <div className="num text-[13px] mt-1">
                  #{state.closedContract.contractId} · {state.closedContract.contractType} {state.closedContract.symbol} ·{" "}
                  <span style={{ color: (state.closedContract.profit ?? 0) >= 0 ? "#2bd98a" : "#ff5a5a" }}>
                    {money(state.closedContract.profit ?? 0, state.closedContract.currency)}
                  </span>{" "}
                  · {state.closedContract.status.toUpperCase()}
                </div>
                <div className="text-[11px] text-[var(--muted)] num mt-1">{state.closedContract.exitReason}</div>
              </div>
            ) : null}
          </div>
        )}
      </Band>

      {/* ================================================ EMERGENCY CONTROLS */}
      <Band index="SECTION 04" title="EMERGENCY CONTROLS" right={<span className="pill">{state.autoStatus}</span>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button
            className={`btn ${state.autoTrading ? "btn-danger" : "btn-buy"}`}
            disabled={busy !== null}
            onClick={() => void send({ action: "setAuto", auto: !state.autoTrading }, state.autoTrading ? "STOP" : "START")}
          >
            {state.autoTrading ? "■ STOP AUTO TRADING" : "▶ ARM AUTO TRADING"}
          </button>
          <button
            className="btn"
            disabled={busy !== null || !c}
            onClick={() => void send({ action: "sell" }, "EXIT")}
          >
            ◆ CLOSE / EXIT CONTRACT
          </button>
          <button className="btn btn-danger" disabled={busy !== null} onClick={() => void send({ action: "disconnect" }, "DISCONNECT")}>
            ⏻ DISCONNECT DERIV
          </button>
          <button className="btn" disabled={busy !== null} onClick={() => void send({ action: "reconnect" }, "RECONNECT")}>
            ↻ RECONNECT + RESYNC
          </button>
        </div>
        <div className="text-[11px] text-[var(--muted)] num mt-3">
          STOP AUTO TRADING prevents any new entry. Existing contracts continue to be monitored through Deriv
          proposal_open_contract until settlement. DISCONNECT closes the WebSocket and blocks all trading until re-authorized.
        </div>
        {notice ? (
          <div
            className={`mt-3 px-3 py-2 border text-[11px] num ${
              notice.tone === "ok"
                ? "border-[rgba(43,217,138,.35)] text-[var(--buy)]"
                : "border-[rgba(255,90,90,.35)] text-[var(--sell)]"
            }`}
          >
            {notice.text}
          </div>
        ) : null}
      </Band>

      {/* ================================================ ACCOUNT SAFETY GATE */}
      <Band
        index="SECTION 05"
        title="ACCOUNT SAFETY — DEMO / REAL GATE"
        right={
          <span className={`pill ${isReal ? "pill-danger" : "pill-live"}`}>
            <span className="dot" />
            {accountBadge}
          </span>
        }
      >
        <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="plate p-5">
            <div className="legend legend-muted">AUTHENTICATED DERIV ACCOUNT</div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <Readout label="ACCOUNT TYPE" value={state.account ? (state.account.isVirtual ? "DEMO (virtual)" : "REAL (non-virtual)") : "UNKNOWN"} sub="returned by Deriv authorize" tone={isReal ? "#ff5a5a" : "#2bd98a"} />
              <Readout label="ACCOUNT CURRENCY" value={state.account?.currency ?? "—"} sub={state.account?.loginid ?? "not authenticated"} />
              <Readout label="BALANCE" value={money(state.account?.balance, state.account?.currency ?? "USD")} sub="Deriv balance.balance" />
              <Readout label="AVAILABLE BALANCE" value={money(state.account?.available, state.account?.currency ?? "USD")} sub={`balance − open exposure ${money(state.account?.exposure ?? 0, state.account?.currency ?? "USD")}`} />
            </div>

            <div className="mt-4 p-3 border border-[var(--hairline)] bg-[#0e161b]">
              <div className="legend">{isReal ? "REAL ACCOUNT WARNING" : "DEMO ACCOUNT"}</div>
              <div className="text-[11.5px] num mt-2 text-[var(--ink)]">
                {isReal
                  ? "Trades will use real funds from your Deriv account."
                  : "Trades use live Deriv market data and real API execution with virtual demo funds. Demo funds are NOT real money."}
              </div>
            </div>

            {state.account?.accountList.length ? (
              <div className="mt-4">
                <div className="legend legend-muted mb-1">ACCOUNTS RETURNED BY DERIV</div>
                {state.account.accountList.map((a) => (
                  <div key={a.loginid} className="flex justify-between text-[11px] num py-1 border-b border-[var(--hairline-soft)]">
                    <span>{a.loginid}</span>
                    <span className={a.isVirtual ? "text-[var(--buy)]" : "text-[var(--sell)]"}>
                      {a.isVirtual ? "DEMO" : "REAL"} · {a.currency}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="hairline my-4" />
            <div className="legend legend-muted mb-2">DERIV API CREDENTIALS (SERVER-SIDE ONLY)</div>
            <div className="text-[10.5px] text-[var(--muted)] num mb-2">
              Read from DERIV_APP_ID / DERIV_API_TOKEN_DEMO / DERIV_API_TOKEN_REAL, or stored below. Tokens are held in the
              server database and are never returned to the browser.
            </div>
            <div className="flex gap-2 flex-wrap">
              <select className="field num w-[110px]" value={tokenMode} onChange={(e) => setTokenMode(e.target.value as "demo" | "real")}>
                <option value="demo">DEMO</option>
                <option value="real">REAL</option>
              </select>
              <input
                className="field num flex-1 min-w-[180px]"
                type="password"
                placeholder="Deriv API token"
                value={tokenValue}
                onChange={(e) => setTokenValue(e.target.value)}
              />
              <button
                className="btn"
                disabled={busy !== null || !tokenValue}
                onClick={() => {
                  void send({ action: "saveToken", mode: tokenMode, token: tokenValue }, "TOKEN").then(() => setTokenValue(""));
                }}
              >
                STORE
              </button>
            </div>
            <div className="mt-3">
              <button className="btn w-full" disabled={busy !== null} onClick={() => void send({ action: "preflight" }, "PREFLIGHT")}>
                {busy === "PREFLIGHT" ? "RUNNING LIVE CHECKS…" : "RUN LIVE DERIV PREFLIGHT (14 CHECKS)"}
              </button>
            </div>
          </div>

          <div className="plate p-5">
            <div className="flex items-center justify-between">
              <div className="legend legend-muted">REAL-TRADING UNLOCK CHECKLIST</div>
              <span className="pill">
                {state.preflight.filter((p: PreflightItem) => p.ok).length} / {state.preflight.length || 14} PASSING
              </span>
            </div>
            <div className="mt-3 max-h-[330px] overflow-y-auto pr-1">
              {(state.preflight.length ? state.preflight : DEFAULT_PREFLIGHT).map((p: PreflightItem) => (
                <div key={p.key} className="check-row">
                  <span className={`check-mark ${p.ok ? "check-ok" : "check-no"}`}>{p.ok ? "✓" : "✗"}</span>
                  <span>
                    <span className="num text-[var(--ink-strong)]">{p.label}</span>
                    <br />
                    <span className="num text-[10.5px] text-[var(--muted)]">{p.detail}</span>
                  </span>
                </div>
              ))}
            </div>

            <div className="hairline my-4" />
            <div className="legend text-[var(--sell)]">REAL ACCOUNT WARNING</div>
            <div className="text-[12px] num mt-2 text-[var(--ink)]">Trades will use real funds from your Deriv account.</div>
            <div className="text-[11px] num mt-1 text-[var(--muted)]">
              Type <span className="text-[var(--amber)]">{CONFIRM_PHRASE}</span> to enable real-money automated trading. The
              platform never switches from DEMO to REAL automatically.
            </div>
            <div className="flex gap-2 mt-3 flex-wrap">
              <input
                className="field num flex-1 min-w-[200px]"
                placeholder={CONFIRM_PHRASE}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
              />
              <button
                className="btn btn-danger"
                disabled={busy !== null || confirmText.trim() !== CONFIRM_PHRASE}
                onClick={() =>
                  void send({ action: "switchAccount", mode: "real", phrase: confirmText.trim() }, "REAL").then((r) => {
                    if (r.ok) setConfirmText("");
                  })
                }
              >
                ENABLE REAL TRADING
              </button>
            </div>
            <button
              className="btn w-full mt-3"
              disabled={busy !== null}
              onClick={() => void send({ action: "switchAccount", mode: "demo" }, "DEMO")}
            >
              SWITCH BACK TO DEMO ACCOUNT
            </button>
            <div className="mt-3 text-[10.5px] num text-[var(--muted)]">
              Switching accounts re-authenticates the Deriv WebSocket, clears the current account state, stops automation and
              re-synchronizes balance, portfolio and open contracts before trading can resume.
            </div>
          </div>
        </div>
      </Band>

      {/* ============================================================ RISK */}
      <Band
        index="SECTION 06"
        title="RISK MANAGER & STAKE MANAGEMENT"
        right={
          <span className={`pill ${(state.riskDecision?.approved ?? false) ? "pill-live" : "pill-warn"}`}>
            {(state.riskDecision?.approved ?? false) ? "RISK APPROVED" : `RISK: ${(state.riskDecision?.blockers ?? ["evaluating"]).join(", ")}`}
          </span>
        }
      >
        {riskDraft ? (
          <div className="plate p-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <NumberField label="MAX CONCURRENT TRADES" value={riskDraft.maxConcurrentTrades} onChange={(v) => setRiskDraft({ ...riskDraft, maxConcurrentTrades: v })} />
              <NumberField label="MAX DAILY TRADES" value={riskDraft.maxDailyTrades} onChange={(v) => setRiskDraft({ ...riskDraft, maxDailyTrades: v })} />
              <NumberField label="MAX DAILY LOSS" value={riskDraft.maxDailyLoss} onChange={(v) => setRiskDraft({ ...riskDraft, maxDailyLoss: v })} />
              <NumberField label="MAX CONSECUTIVE LOSSES" value={riskDraft.maxConsecutiveLosses} onChange={(v) => setRiskDraft({ ...riskDraft, maxConsecutiveLosses: v })} />
              <NumberField label="COOLDOWN (SECONDS)" value={riskDraft.cooldownSeconds} onChange={(v) => setRiskDraft({ ...riskDraft, cooldownSeconds: v })} />
              <NumberField label="MAX STAKE % OF BALANCE" value={riskDraft.maxStakePercent} onChange={(v) => setRiskDraft({ ...riskDraft, maxStakePercent: v })} step={0.1} />
              <NumberField label="MINIMUM BALANCE" value={riskDraft.minBalance} onChange={(v) => setRiskDraft({ ...riskDraft, minBalance: v })} step={0.5} />
              <NumberField label="CONFIDENCE THRESHOLD %" value={riskDraft.confidenceThreshold} onChange={(v) => setRiskDraft({ ...riskDraft, confidenceThreshold: v })} />
              <div>
                <label className="legend legend-muted block mb-1">STAKE MODE</label>
                <select
                  className="field num"
                  value={riskDraft.stakeMode}
                  onChange={(e) => setRiskDraft({ ...riskDraft, stakeMode: e.target.value as "fixed" | "percent" })}
                >
                  <option value="fixed">FIXED STAKE</option>
                  <option value="percent">% OF BALANCE</option>
                </select>
              </div>
              <NumberField label="FIXED STAKE" value={riskDraft.fixedStake} onChange={(v) => setRiskDraft({ ...riskDraft, fixedStake: v })} step={0.35} />
              <NumberField label="PERCENT STAKE %" value={riskDraft.percentStake} onChange={(v) => setRiskDraft({ ...riskDraft, percentStake: v })} step={0.1} />
              <NumberField label="ABSOLUTE STAKE CAP" value={riskDraft.maxStakeAbsolute} onChange={(v) => setRiskDraft({ ...riskDraft, maxStakeAbsolute: v })} step={1} />
            </div>
            <div className="flex gap-3 mt-4 flex-wrap">
              <button
                className="btn btn-amber"
                disabled={busy !== null}
                onClick={() => void send({ action: "setRisk", risk: riskDraft }, "RISK")}
              >
                {busy === "RISK" ? "SAVING…" : "SAVE RISK CONFIGURATION"}
              </button>
              <div className="flex items-center gap-4 flex-wrap">
                <Toggle
                  label="HALT ON DAILY LOSS"
                  checked={riskDraft.stopOnDailyLoss}
                  onChange={(v) => setRiskDraft({ ...riskDraft, stopOnDailyLoss: v })}
                />
                <Toggle
                  label="HALT ON CONSECUTIVE LOSSES"
                  checked={riskDraft.stopOnConsecutiveLosses}
                  onChange={(v) => setRiskDraft({ ...riskDraft, stopOnConsecutiveLosses: v })}
                />
              </div>
            </div>

            <div className="hairline my-4" />
            <div className="grid gap-3 sm:grid-cols-3">
              <Readout label="CALCULATED STAKE" value={money(state.riskDecision?.stake ?? 0, state.account?.currency ?? "USD")} sub={state.riskDecision?.stakeBasis} />
              <Readout label="TODAY" value={`${state.stats.todayTrades} trades · ${money(state.stats.todayProfit, state.account?.currency ?? "USD")}`} sub={`limits ${state.risk.maxDailyTrades} trades · ${money(state.risk.maxDailyLoss, state.account?.currency ?? "USD")} loss`} />
              <Readout label="CONSECUTIVE LOSSES" value={`${state.stats.consecutiveLosses}`} sub={`halt at ${state.risk.maxConsecutiveLosses}`} tone={state.stats.consecutiveLosses >= state.risk.maxConsecutiveLosses ? "#ff5a5a" : undefined} />
            </div>
          </div>
        ) : null}
      </Band>

      {/* ====================================================== TRADE HISTORY */}
      <Band
        index="SECTION 07"
        title="TRADE HISTORY — ACTUAL DERIV RESULTS"
        right={
          <button className="btn" onClick={() => void loadTrades()}>
            ⟳ REFRESH
          </button>
        }
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Readout label="TOTAL TRADES" value={String(state.stats.totalTrades)} sub={`${state.stats.openTrades} open`} />
          <Readout label="WINS / LOSSES" value={`${state.stats.wins} / ${state.stats.losses}`} sub={`win rate ${state.stats.winRate}%`} tone="#2bd98a" />
          <Readout label="NET P/L" value={money(state.stats.netProfit, state.account?.currency ?? "USD")} sub="from Deriv settlement" tone={state.stats.netProfit >= 0 ? "#2bd98a" : "#ff5a5a"} />
          <Readout label="GROSS PROFIT" value={money(state.stats.grossProfit, state.account?.currency ?? "USD")} />
          <Readout label="GROSS LOSS" value={money(state.stats.grossLoss, state.account?.currency ?? "USD")} tone="#ff5a5a" />
          <Readout label="AVG STAKE" value={money(state.stats.avgStake, state.account?.currency ?? "USD")} />
        </div>

        <div className="table-wrap mt-4">
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Account</th>
                <th>Symbol</th>
                <th>Contract</th>
                <th>Dir</th>
                <th>Stake</th>
                <th>Payout</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>P/L</th>
                <th>Conf</th>
                <th>EMA20/50/200</th>
                <th>RSI</th>
                <th>ADX</th>
                <th>Mom</th>
                <th>ATR</th>
                <th>Status</th>
                <th>Entry reason</th>
                <th>Exit reason</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 ? (
                <tr>
                  <td colSpan={19} className="text-center text-[var(--muted)] py-6">
                    No Deriv trades recorded yet. Execute a demo contract to populate this ledger — every row is written from a
                    real Deriv buy/settlement response.
                  </td>
                </tr>
              ) : (
                trades.map((t) => (
                  <tr key={t.id}>
                    <td className="num">{new Date(t.createdAt).toLocaleString("en-GB", { hour12: false })}</td>
                    <td>
                      <span className={`pill ${t.accountType === "real" ? "pill-danger" : "pill-live"}`}>{t.accountType.toUpperCase()}</span>
                    </td>
                    <td className="num">{t.symbol}</td>
                    <td className="num text-[var(--amber)]">{t.contractId ?? "—"}</td>
                    <td className="num" style={{ color: t.direction === "BUY" ? "#2bd98a" : "#ff5a5a" }}>
                      {t.direction}
                    </td>
                    <td className="num">{money(t.stake, t.currency ?? "USD")}</td>
                    <td className="num">{money(t.payout, t.currency ?? "USD")}</td>
                    <td className="num">{fmt(t.entrySpot, 5)}</td>
                    <td className="num">{fmt(t.exitSpot, 5)}</td>
                    <td className="num" style={{ color: (t.profit ?? 0) >= 0 ? "#2bd98a" : "#ff5a5a" }}>
                      {t.profit === null ? "—" : money(t.profit, t.currency ?? "USD")}
                    </td>
                    <td className="num">{t.confidence}%</td>
                    <td className="num">
                      {fmt(t.ema20, 3)} / {fmt(t.ema50, 3)} / {fmt(t.ema200, 3)}
                    </td>
                    <td className="num">{fmt(t.rsi, 2)}</td>
                    <td className="num">{fmt(t.adx, 2)}</td>
                    <td className="num">{fmt(t.momentum, 3)}</td>
                    <td className="num">{fmt(t.atr, 5)}</td>
                    <td>
                      <span
                        className={`pill ${
                          t.status === "won" ? "pill-live" : t.status === "lost" ? "pill-danger" : "pill-warn"
                        }`}
                      >
                        {t.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="num max-w-[260px] whitespace-normal text-[10.5px]">{t.entryReason ?? "—"}</td>
                    <td className="num max-w-[240px] whitespace-normal text-[10.5px]">{t.exitReason ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Band>

      {/* ============================================================ LOG */}
      <Band
        index="SECTION 08"
        title="DERIV API EVENT LOG"
        right={
          <button className="btn" onClick={() => setLogOpen((v) => !v)}>
            {logOpen ? "COLLAPSE" : `EXPAND (${state.log.length})`}
          </button>
        }
      >
        <div className="plate p-4">
          {(logOpen ? state.log : state.log.slice(0, 12)).map((l: LogEntry, i: number) => (
            <div className="log-line" key={`${l.ts}-${i}`}>
              <span className="log-ts">{timeStr(l.ts)}</span>
              <span
                className="num uppercase"
                style={{
                  color:
                    l.level === "error" ? "#ff5a5a" : l.level === "warn" ? "#f5a524" : l.level === "trade" ? "#2bd98a" : "#7e9099",
                  minWidth: 68,
                }}
              >
                {l.channel}
              </span>
              <span className="num text-[var(--ink)]">{l.message}</span>
            </div>
          ))}
          {state.log.length === 0 ? <div className="text-[var(--muted)] num text-[11px]">no events yet</div> : null}
        </div>
      </Band>

      {/* ========================================================= FOOTNOTE */}
      <footer className="band">
        <div className="band-inner">
          <div className="hairline mb-4" />
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="legend">DEPLOYMENT</div>
              <div className="text-[11px] num text-[var(--muted)] mt-2">
                Next.js (App Router, Node runtime) + PostgreSQL via Drizzle ORM.
                <br />
                <span className="text-[var(--ink)]">npm run build</span> · <span className="text-[var(--ink)]">npm run start</span>
              </div>
            </div>
            <div>
              <div className="legend">ENVIRONMENT</div>
              <div className="text-[11px] num text-[var(--muted)] mt-2">
                DATABASE_URL
                <br />
                DERIV_APP_ID
                <br />
                DERIV_API_TOKEN_DEMO
                <br />
                DERIV_API_TOKEN_REAL
              </div>
            </div>
            <div>
              <div className="legend">CRITICAL RULE</div>
              <div className="text-[11px] num text-[var(--muted)] mt-2">
                No backtesting. No paper trading. No simulated execution. Real Deriv market data and real Deriv API execution
                for both DEMO and REAL accounts — the only difference is the account being authenticated.
              </div>
            </div>
          </div>
          <div className="text-[10px] num text-[var(--muted)] mt-6">
            FOREX VISION PROS · DERIV SNIPER AI — automated trading involves substantial risk of loss. Demo performance does not
            guarantee real-account results.
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------- sub-widgets */
function IndicatorRow({
  name,
  value,
  reading,
  ok,
}: {
  name: string;
  value: string;
  reading: string;
  ok: boolean;
}) {
  return (
    <tr>
      <td className="num text-[var(--ink-strong)]">{name}</td>
      <td className="num text-[var(--amber)]">{value}</td>
      <td className="num text-[var(--muted)] text-[10.5px]">{reading}</td>
      <td>
        <span className={`pill ${ok ? "pill-live" : "pill-warn"}`}>{ok ? "CONFIRMED" : "NOT MET"}</span>
      </td>
    </tr>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <div>
      <label className="legend legend-muted block mb-1">{label}</label>
      <input
        className="field num"
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 cursor-pointer"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <span
        className="w-[38px] h-[20px] rounded-full relative transition-colors"
        style={{ background: checked ? "rgba(43,217,138,.28)" : "#1b252c", border: `1px solid ${checked ? "#2bd98a" : "#243139"}` }}
      >
        <span
          className="absolute top-[2px] h-[14px] w-[14px] rounded-full transition-all"
          style={{ left: checked ? 20 : 2, background: checked ? "#2bd98a" : "#7e9099" }}
        />
      </span>
      <span className="legend legend-muted">{label}</span>
    </button>
  );
}

const DEFAULT_PREFLIGHT: PreflightItem[] = [
  { key: "connection", label: "1 · Deriv connection", ok: false, detail: "not run" },
  { key: "auth", label: "2 · Authentication", ok: false, detail: "not run" },
  { key: "account", label: "3 · Account detection", ok: false, detail: "not run" },
  { key: "price", label: "4 · Live price", ok: false, detail: "not run" },
  { key: "stream", label: "5 · Live candle stream", ok: false, detail: "not run" },
  { key: "indicators", label: "6 · Indicator calculation", ok: false, detail: "not run" },
  { key: "signal", label: "7 · Signal generation", ok: false, detail: "not run" },
  { key: "proposal_req", label: "8 · Proposal request", ok: false, detail: "not run" },
  { key: "proposal_res", label: "9 · Proposal response", ok: false, detail: "not run" },
  { key: "purchase", label: "10 · Demo contract purchase", ok: false, detail: "not run" },
  { key: "monitor", label: "11 · Contract monitoring", ok: false, detail: "not run" },
  { key: "settlement", label: "12 · Settlement", ok: false, detail: "not run" },
  { key: "pnl", label: "13 · Actual P/L retrieval", ok: false, detail: "not run" },
  { key: "db", label: "14 · Database recording", ok: false, detail: "not run" },
];
