const { sma, rsi, summarize } = require('../src/services/analytics');
const { MarketSimulator } = require('../src/services/marketSimulator');

test('sma averages a sliding window', () => {
  expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
});

test('rsi is 100 for a strictly rising series and within 0..100 otherwise', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  expect(rsi(up, 14).at(-1)).toBe(100);
  const zig = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 1 : -1) * (i % 5));
  const v = rsi(zig, 14).filter((x) => x != null);
  expect(v.every((x) => x >= 0 && x <= 100)).toBe(true);
});

test('summarize reports return and drawdown', () => {
  const bars = [100, 120, 90, 110].map((c, i) => ({ date: `2026-01-0${i + 1}`, close: c, high: c, low: c, volume: 10 }));
  const s = summarize(bars);
  expect(s.returnPct).toBe(10);
  expect(s.maxDrawdownPct).toBe(-25);
});

test('simulator generates weekday history ending at the live price and emits ticks', () => {
  const m = new MarketSimulator(['AAPL', 'XYZ']);
  const bars = m.generateHistory('AAPL', 100);
  expect(bars).toHaveLength(100);
  expect(bars.every((b) => ![0, 6].includes(new Date(b.date).getUTCDay()))).toBe(true);
  expect(bars.every((b) => b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close))).toBe(true);
  expect(bars.at(-1).close).toBe(m.quote('AAPL').prevClose);

  const ticks = [];
  m.on('tick', (t) => ticks.push(t));
  m.step();
  expect(ticks.map((t) => t.symbol)).toEqual(['AAPL', 'XYZ']);
  expect(ticks[0].price).toBeGreaterThan(0);
});
