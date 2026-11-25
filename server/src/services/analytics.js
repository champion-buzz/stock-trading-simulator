const round = (x, d = 2) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Simple moving average aligned with the input (null until the window fills). */
function sma(values, window) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = round(sum / window);
  }
  return out;
}

/** Relative Strength Index (Wilder's smoothing). */
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = round(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = round(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  }
  return out;
}

/** Summary statistics for a series of daily bars. */
function summarize(bars) {
  if (!bars.length) return null;
  const closes = bars.map((b) => b.close);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(rets.length - 1, 1);
  let peak = closes[0];
  let maxDd = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    maxDd = Math.min(maxDd, (c - peak) / peak);
  }
  const first = closes[0];
  const last = closes[closes.length - 1];
  return {
    from: bars[0].date,
    to: bars[bars.length - 1].date,
    days: bars.length,
    start: first,
    end: last,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    returnPct: round(((last - first) / first) * 100),
    annualizedVolatilityPct: round(Math.sqrt(variance) * Math.sqrt(252) * 100),
    maxDrawdownPct: round(maxDd * 100),
    avgVolume: Math.round(bars.reduce((a, b) => a + b.volume, 0) / bars.length),
  };
}

module.exports = { sma, rsi, summarize, round };
