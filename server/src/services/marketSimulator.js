const { EventEmitter } = require('events');

// Rough starting prices and annualized volatilities so the simulation looks realistic.
const PROFILES = {
  AAPL: { name: 'Apple Inc.', price: 228, vol: 0.25 },
  MSFT: { name: 'Microsoft Corp.', price: 425, vol: 0.23 },
  GOOGL: { name: 'Alphabet Inc.', price: 172, vol: 0.28 },
  AMZN: { name: 'Amazon.com Inc.', price: 195, vol: 0.32 },
  NVDA: { name: 'NVIDIA Corp.', price: 138, vol: 0.5 },
  TSLA: { name: 'Tesla Inc.', price: 250, vol: 0.6 },
  META: { name: 'Meta Platforms Inc.', price: 560, vol: 0.38 },
  NFLX: { name: 'Netflix Inc.', price: 700, vol: 0.35 },
  AMD: { name: 'Advanced Micro Devices', price: 150, vol: 0.48 },
  INTC: { name: 'Intel Corp.', price: 23, vol: 0.45 },
};

const TRADING_SECONDS_PER_YEAR = 252 * 6.5 * 3600;
const round2 = (x) => Math.round(x * 100) / 100;

/** Seeded PRNG (mulberry32) so history is reproducible per symbol. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function hashSymbol(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * Generates live prices with geometric Brownian motion and emits a 'tick' event
 * per update: { symbol, price, change, changePct, volume, ts }.
 */
class MarketSimulator extends EventEmitter {
  constructor(symbols, { tickIntervalMs = 1000, random = Math.random } = {}) {
    super();
    this.setMaxListeners(0);
    this.tickIntervalMs = tickIntervalMs;
    this.random = random;
    this.quotes = new Map();
    for (const symbol of symbols) {
      const p = PROFILES[symbol] || { name: symbol, price: 50 + (hashSymbol(symbol) % 200), vol: 0.35 };
      this.quotes.set(symbol, {
        symbol,
        name: p.name,
        vol: p.vol,
        price: p.price,
        open: p.price,
        high: p.price,
        low: p.price,
        prevClose: p.price,
        volume: 0,
        ts: Date.now(),
      });
    }
  }

  /** Builds `days` of daily OHLCV bars ending yesterday, and anchors live prices to the last close. */
  generateHistory(symbol, days) {
    const q = this.quotes.get(symbol);
    const rand = rng(hashSymbol(symbol));
    const dailyVol = q.vol / Math.sqrt(252);
    const bars = [];
    // walk backwards from today's price so the series ends near the live price
    let close = q.price;
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    for (let d = 1, made = 0; made < days; d++) {
      const date = new Date(now.getTime() - d * 86400000);
      const dow = date.getUTCDay();
      if (dow === 0 || dow === 6) continue; // skip weekends
      const ret = dailyVol * gaussian(rand) + 0.0003;
      const open = close / Math.exp(ret);
      const high = Math.max(open, close) * (1 + Math.abs(gaussian(rand)) * dailyVol * 0.4);
      const low = Math.min(open, close) * (1 - Math.abs(gaussian(rand)) * dailyVol * 0.4);
      bars.push({
        symbol,
        date: date.toISOString().slice(0, 10),
        open: round2(open),
        high: round2(high),
        low: round2(low),
        close: round2(close),
        volume: Math.round(5e6 + rand() * 4e7),
      });
      close = open;
      made++;
    }
    bars.reverse();
    if (bars.length) {
      const last = bars[bars.length - 1];
      Object.assign(q, { prevClose: last.close, open: q.price, high: q.price, low: q.price });
    }
    return bars;
  }

  step() {
    const dt = this.tickIntervalMs / 1000 / TRADING_SECONDS_PER_YEAR;
    const ts = Date.now();
    for (const q of this.quotes.values()) {
      // amplify per-tick moves ~30x so the demo visibly moves within minutes
      const sigma = q.vol * Math.sqrt(dt) * 30;
      const ret = sigma * gaussian(this.random) - 0.5 * sigma * sigma;
      q.price = Math.max(0.01, round2(q.price * Math.exp(ret)));
      q.high = Math.max(q.high, q.price);
      q.low = Math.min(q.low, q.price);
      const vol = Math.round(this.random() * 5000);
      q.volume += vol;
      q.ts = ts;
      this.emit('tick', this.toQuote(q, vol));
    }
  }

  toQuote(q, lastVolume = 0) {
    const change = round2(q.price - q.prevClose);
    return {
      symbol: q.symbol,
      name: q.name,
      price: q.price,
      open: q.open,
      high: q.high,
      low: q.low,
      prevClose: q.prevClose,
      change,
      changePct: round2((change / q.prevClose) * 100),
      volume: q.volume,
      lastVolume,
      ts: q.ts,
    };
  }

  quote(symbol) {
    const q = this.quotes.get(symbol);
    return q ? this.toQuote(q) : null;
  }

  allQuotes() {
    return [...this.quotes.values()].map((q) => this.toQuote(q));
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.step(), this.tickIntervalMs);
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { MarketSimulator };
