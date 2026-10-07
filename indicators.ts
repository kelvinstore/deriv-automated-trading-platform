/**
 * Technical indicators calculated from ACTUAL Deriv candle data only.
 * Pure functions — no randomness, no synthetic series, no fallbacks.
 */

export interface Candle {
  epoch: number; // candle open time (seconds)
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface IndicatorSet {
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  adx14: number | null;
  diPlus: number | null;
  diMinus: number | null;
  momentum14: number | null;
  atr14: number | null;
  atrPercent: number | null;
  atrMedian: number | null;
  ema50Slope: number | null;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function rsi(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function atr(candles: Candle[], period = 14): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  const tr: number[] = [NaN];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export interface AdxResult {
  adx: number[];
  diPlus: number[];
  diMinus: number[];
}

export function adx(candles: Candle[], period = 14): AdxResult {
  const n = candles.length;
  const diPlus = new Array<number>(n).fill(NaN);
  const diMinus = new Array<number>(n).fill(NaN);
  const adxArr = new Array<number>(n).fill(NaN);
  if (n < period * 2 + 1) return { adx: adxArr, diPlus, diMinus };

  const tr: number[] = [NaN];
  const plusDm: number[] = [NaN];
  const minusDm: number[] = [NaN];
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }

  let trS = 0;
  let pdmS = 0;
  let mdmS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pdmS += plusDm[i];
    mdmS += minusDm[i];
  }
  const dx: number[] = new Array(n).fill(NaN);
  const smooth = (prev: number, value: number) => prev - prev / period + value;

  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = smooth(trS, tr[i]);
      pdmS = smooth(pdmS, plusDm[i]);
      mdmS = smooth(mdmS, minusDm[i]);
    }
    const plus = trS === 0 ? 0 : (pdmS / trS) * 100;
    const minus = trS === 0 ? 0 : (mdmS / trS) * 100;
    diPlus[i] = plus;
    diMinus[i] = minus;
    const denom = plus + minus;
    dx[i] = denom === 0 ? 0 : (Math.abs(plus - minus) / denom) * 100;
  }

  const firstDx = period * 2 - 1;
  if (firstDx < n) {
    let seed = 0;
    for (let i = period; i <= firstDx; i++) seed += dx[i];
    let prevAdx = seed / period;
    adxArr[firstDx] = prevAdx;
    for (let i = firstDx + 1; i < n; i++) {
      prevAdx = (prevAdx * (period - 1) + dx[i]) / period;
      adxArr[i] = prevAdx;
    }
  }
  return { adx: adxArr, diPlus, diMinus };
}

export function momentum(values: number[], period = 14): number {
  if (values.length <= period) return NaN;
  const now = values[values.length - 1];
  const then = values[values.length - 1 - period];
  return then === 0 ? NaN : (now / then) * 100;
}

function lastValid(arr: number[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return null;
}

export function computeIndicators(candles: Candle[]): IndicatorSet {
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const a = adx(candles, 14);
  const atrSeries = atr(candles, 14);
  const atrVal = lastValid(atrSeries);
  const price = closes.length ? closes[closes.length - 1] : null;
  const m = momentum(closes, 14);

  // Median ATR over the last 50 closed candles -> volatility regime baseline.
  const atrWindow = atrSeries.filter((v) => Number.isFinite(v)).slice(-50).sort((x, y) => x - y);
  const atrMedian = atrWindow.length ? atrWindow[Math.floor(atrWindow.length / 2)] : null;

  const slopeLookback = Math.min(3, e50.length - 1);
  const ema50Slope =
    slopeLookback > 0 && Number.isFinite(e50[e50.length - 1]) && Number.isFinite(e50[e50.length - 1 - slopeLookback])
      ? e50[e50.length - 1] - e50[e50.length - 1 - slopeLookback]
      : null;

  return {
    ema20: lastValid(e20),
    ema50: lastValid(e50),
    ema200: lastValid(e200),
    rsi14: lastValid(r),
    adx14: lastValid(a.adx),
    diPlus: lastValid(a.diPlus),
    diMinus: lastValid(a.diMinus),
    momentum14: Number.isFinite(m) ? m : null,
    atr14: atrVal,
    atrPercent: atrVal && price ? (atrVal / price) * 100 : null,
    atrMedian,
    ema50Slope,
  };
}

/** Minimum number of closed candles required for a trustworthy read. */
export const MIN_CANDLES = 210;
