/**
 * DERIV SNIPER AI — weighted confirmation strategy.
 *
 * Weighting (100%):
 *   EMA trend 30 · ADX 20 · RSI 20 · Momentum 15 · Price structure 15
 *
 * The evaluator runs ONLY on closed candles supplied by Deriv.
 */

import type { Candle, IndicatorSet } from "./indicators";

export type SignalDirection = "BUY" | "SELL" | "WAIT";

export interface Check {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface Evaluation {
  signal: SignalDirection;
  confidence: number;
  direction: "BUY" | "SELL" | "NONE";
  scores: { ema: number; adx: number; rsi: number; momentum: number; price: number; total: number };
  checks: Check[];
  reasons: string[];
  blockers: string[];
  entryReason: string;
}

export interface EvaluationContext {
  threshold: number;
  atrMinPercent: number;
  atrMaxPercent: number;
  hasOpenTrade: boolean;
  riskApproved: boolean;
  riskBlockers: string[];
  connectionReady: boolean;
  dataReady: boolean;
  proposalReady: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function structureScore(candles: Candle[], dir: number, ema20: number, atr: number): { score: number; ok: boolean } {
  if (candles.length < 6 || !Number.isFinite(ema20) || !Number.isFinite(atr)) return { score: 0, ok: false };
  const last = candles[candles.length - 1];
  const prev = candles.slice(-6, -1);

  let structure = 0;
  if (dir > 0) {
    let higherLows = 0;
    for (let i = 1; i < prev.length; i++) if (prev[i].low >= prev[i - 1].low) higherLows++;
    structure = (higherLows / (prev.length - 1)) * 5;
  } else {
    let lowerHighs = 0;
    for (let i = 1; i < prev.length; i++) if (prev[i].high <= prev[i - 1].high) lowerHighs++;
    structure = (lowerHighs / (prev.length - 1)) * 5;
  }

  const aboveEma = (last.close - ema20) * dir > 0 ? 5 : 0;
  const dist = Math.abs(last.close - ema20);
  const notExtended = Number.isFinite(atr) && dist <= 1.5 * atr ? 5 : 0;
  return { score: aboveEma + structure + notExtended, ok: aboveEma > 0 };
}

export function evaluate(ind: IndicatorSet, candles: Candle[], ctx: EvaluationContext): Evaluation {
  const checks: Check[] = [];
  const reasons: string[] = [];
  const blockers: string[] = [];

  const price = candles.length ? candles[candles.length - 1].close : NaN;
  const { ema20, ema50, ema200, rsi14, adx14, momentum14, atr14, atrPercent, ema50Slope } = ind;

  const complete = [
    ema20,
    ema50,
    ema200,
    rsi14,
    adx14,
    momentum14,
    atr14,
    atrPercent,
  ].every((v) => typeof v === "number" && Number.isFinite(v));

  if (!ctx.dataReady || !complete || candles.length < 210) {
    blockers.push("WAIT — market data unavailable");
    return {
      signal: "WAIT",
      confidence: 0,
      direction: "NONE",
      scores: { ema: 0, adx: 0, rsi: 0, momentum: 0, price: 0, total: 0 },
      checks,
      reasons,
      blockers,
      entryReason: "Waiting for sufficient closed Deriv candles",
    };
  }

  // Non-null locals — `complete` guarantees these are finite numbers.
  const e20 = ema20 as number;
  const e50 = ema50 as number;
  const e200 = ema200 as number;
  const rsiVal = rsi14 as number;
  const adxVal = adx14 as number;
  const momVal = momentum14 as number;

  const emaAligned = e20 > e50 ? 1 : e20 < e50 ? -1 : 0;
  const dir = emaAligned;

  // ---- weighted sub-scores (directional) ----------------------------------
  const emaScore = dir === 0 ? 0 : (e20 - e50) * dir > 0 ? 15 : 0;
  const transition =
    dir !== 0 &&
    ((ema50Slope ?? 0) * dir > 0 || (e50 - e200) * dir >= 0) &&
    (price - e200) * dir > 0;
  const ema50Ok = dir !== 0 && ((e50 - e200) * dir >= 0 || transition);
  const emaScoreTotal = dir === 0 ? 0 : emaScore + (ema50Ok ? 15 : 0);

  const adxScore = clamp((adxVal / 30) * 20, 0, 20);
  const rsiDev = dir === 0 ? 0 : (rsiVal - 50) * dir;
  const rsiScore = dir === 0 ? 0 : clamp((rsiDev / 15) * 20, 0, 20);

  const atr = atr14 as number;
  const momDev = dir === 0 ? 0 : (((momVal - 100) / 100) * price * dir) / atr;
  const momScore = dir === 0 ? 0 : clamp((Math.abs(momDev) / 2) * 15, 0, 15) * (momDev >= 0 ? 1 : 0);

  const struct = dir === 0 ? { score: 0, ok: false } : structureScore(candles, dir, ema20 as number, atr);

  const total = Math.round(emaScoreTotal + adxScore + rsiScore + momScore + struct.score);
  const confidence = clamp(total, 0, 100);

  const dirWord = dir > 0 ? "BUY" : dir < 0 ? "SELL" : "NONE";

  // ---- ten condition checks ----------------------------------------------
  checks.push({
    key: "ema_cross",
    label: dir > 0 ? "EMA20 > EMA50" : dir < 0 ? "EMA20 < EMA50" : "EMA trend not aligned",
    ok: emaScore > 0,
    detail: `EMA20 ${fmt(ema20)} · EMA50 ${fmt(ema50)}`,
  });
  checks.push({
    key: "ema_trend",
    label: dir > 0 ? "EMA50 ≥ EMA200 or confirmed bullish transition" : "EMA50 ≤ EMA200 or confirmed bearish transition",
    ok: ema50Ok,
    detail: `EMA50 ${fmt(ema50)} · EMA200 ${fmt(ema200)}`,
  });
  const priceOk = dir !== 0 && (price - (ema20 as number)) * dir > 0;
  checks.push({
    key: "price_ema",
    label: dir > 0 ? "Price above EMA20" : dir < 0 ? "Price below EMA20" : "Price vs EMA20",
    ok: priceOk,
    detail: `price ${fmt(price)} · EMA20 ${fmt(ema20)}`,
  });
  const rsiOk = dir > 0 ? (rsi14 as number) > 55 : dir < 0 ? (rsi14 as number) < 45 : false;
  checks.push({
    key: "rsi",
    label: dir > 0 ? "RSI > 55" : dir < 0 ? "RSI < 45" : "RSI neutral",
    ok: rsiOk,
    detail: `RSI14 ${fmt(rsi14)}`,
  });
  const adxOk = (adx14 as number) >= 20;
  checks.push({ key: "adx", label: "ADX ≥ 20", ok: adxOk, detail: `ADX14 ${fmt(adx14)}` });
  const momOk = dir > 0 ? (momentum14 as number) > 100 : dir < 0 ? (momentum14 as number) < 100 : false;
  checks.push({
    key: "momentum",
    label: dir > 0 ? "Momentum > 100" : dir < 0 ? "Momentum < 100" : "Momentum unconfirmed",
    ok: momOk,
    detail: `Momentum14 ${fmt(momentum14)}`,
  });
  const atrOk = (atrPercent as number) >= ctx.atrMinPercent && (atrPercent as number) <= ctx.atrMaxPercent;
  checks.push({
    key: "atr",
    label: "ATR within acceptable volatility range",
    ok: atrOk,
    detail: `ATR14 ${fmt(atr)} · ${(atrPercent as number).toFixed(4)}% (allowed ${ctx.atrMinPercent}–${ctx.atrMaxPercent}%)`,
  });
  checks.push({
    key: "conflict",
    label: "No active conflicting position",
    ok: !ctx.hasOpenTrade,
    detail: ctx.hasOpenTrade ? "an open contract is being monitored" : "no open contract",
  });
  checks.push({
    key: "risk",
    label: "Risk manager approves",
    ok: ctx.riskApproved,
    detail: ctx.riskApproved ? "all risk limits satisfied" : ctx.riskBlockers.join(" · ") || "blocked",
  });
  checks.push({
    key: "confidence",
    label: `Confidence ≥ ${ctx.threshold}%`,
    ok: confidence >= ctx.threshold,
    detail: `confidence ${confidence}%`,
  });

  const hardGates: Array<[boolean, string]> = [
    [emaScore > 0, dir > 0 ? "WAIT — EMA trend not aligned" : "WAIT — EMA20 not below EMA50"],
    [ema50Ok, dir > 0 ? "WAIT — EMA50 below EMA200, no bullish transition" : "WAIT — EMA50 above EMA200, no bearish transition"],
    [priceOk, dir > 0 ? "WAIT — price not above EMA20" : "WAIT — price not below EMA20"],
    [rsiOk, dir > 0 ? "WAIT — RSI does not confirm BUY" : "WAIT — RSI does not confirm SELL"],
    [adxOk, "WAIT — ADX below 20"],
    [momOk, dir > 0 ? "WAIT — momentum does not confirm BUY" : "WAIT — momentum does not confirm SELL"],
    [atrOk, "WAIT — ATR abnormal, outside volatility range"],
    [!ctx.hasOpenTrade, "WAIT — existing trade active"],
    [ctx.riskApproved, `WAIT — risk manager: ${ctx.riskBlockers.join(", ") || "limits reached"}`],
    [confidence >= ctx.threshold, `WAIT — confidence ${confidence}%, minimum ${ctx.threshold}%`],
  ];

  if (!ctx.connectionReady) blockers.push("WAIT — Deriv connection unavailable");
  if (!ctx.proposalReady) blockers.push("WAIT — proposal unavailable");

  for (const [ok, msg] of hardGates) {
    if (!ok) blockers.push(msg);
    else reasons.push(msg.replace("WAIT — ", "✓ "));
  }

  const signal: SignalDirection =
    dir !== 0 && blockers.length === 0 ? (dir > 0 ? "BUY" : "SELL") : "WAIT";

  const satisfied: string[] = [];
  for (const c of checks) if (c.ok) satisfied.push(`✓ ${c.label} (${c.detail})`);

  return {
    signal,
    confidence,
    direction: dirWord === "NONE" ? "NONE" : (dirWord as "BUY" | "SELL"),
    scores: {
      ema: Math.round(emaScoreTotal),
      adx: Math.round(adxScore),
      rsi: Math.round(rsiScore),
      momentum: Math.round(momScore),
      price: Math.round(struct.score),
      total: confidence,
    },
    checks,
    reasons: satisfied,
    blockers,
    entryReason:
      signal === "WAIT"
        ? blockers[0] ?? "conditions not met"
        : `${dir > 0 ? "BUY" : "SELL"} ${signal === "BUY" ? "▲" : "▼"} — weighted confirmation ${confidence}% · RSI ${fmt(rsi14)} · ADX ${fmt(adx14)} · Momentum ${fmt(momentum14)} · ATR ${fmt(atr)}`,
  };
}

function fmt(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(5);
}
