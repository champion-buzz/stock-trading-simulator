const request = require('supertest');
const { createApp } = require('../src/app');
const { MarketSimulator } = require('../src/services/marketSimulator');
const { MemoryStore } = require('../src/store/memoryStore');
const { MongoStore } = require('../src/store/mongoStore');
const { seedHistory } = require('../src/index');
const config = require('../src/config');

// Runs the whole API suite against the in-memory store, and again against MongoDB
// when TEST_MONGO_URI is set (CI starts a mongo service container for this).
const backends = [['memory', () => new MemoryStore()]];
if (process.env.TEST_MONGO_URI) backends.push(['mongo', () => new MongoStore(process.env.TEST_MONGO_URI)]);

describe.each(backends)('API with %s store', (name, makeStore) => {
  let app;
  let store;
  let market;
  let token;

  beforeAll(async () => {
    store = makeStore();
    await store.init();
    if (name === 'mongo') {
      const mongoose = require('mongoose');
      await mongoose.connection.db.dropDatabase();
      await store.init();
    }
    market = new MarketSimulator(config.symbols, { tickIntervalMs: 1000 });
    await seedHistory(store, market);
    app = createApp({ store, market, logRequests: false });
  });

  afterAll(async () => {
    market.stop();
    await store.close();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test('registers, rejects duplicates, and logs in', async () => {
    const reg = await request(app).post('/api/auth/register').send({ username: 'sachin', password: 'hunter2hunter2' });
    expect(reg.status).toBe(201);
    expect(reg.body.user.cash).toBe(config.startingCash);
    expect(reg.body.user.passwordHash).toBeUndefined();

    const dup = await request(app).post('/api/auth/register').send({ username: 'SACHIN', password: 'hunter2hunter2' });
    expect(dup.status).toBe(409);

    const bad = await request(app).post('/api/auth/login').send({ username: 'sachin', password: 'wrongpassword' });
    expect(bad.status).toBe(401);

    const ok = await request(app).post('/api/auth/login').send({ username: 'sachin', password: 'hunter2hunter2' });
    expect(ok.status).toBe(200);
    token = ok.body.token;
  });

  test('validates input', async () => {
    const r1 = await request(app).post('/api/auth/register').send({ username: 'x', password: 'short' });
    expect(r1.status).toBe(400);
    expect(r1.body.error.details.map((d) => d.field).sort()).toEqual(['password', 'username']);

    const r2 = await request(app).post('/api/trades').set(auth()).send({ symbol: 'AAPL', side: 'BUY', quantity: 1.5 });
    expect(r2.status).toBe(400);
    const r3 = await request(app).post('/api/trades').set(auth()).send({ symbol: 'AAPL', side: 'HOLD', quantity: 1 });
    expect(r3.status).toBe(400);
    const r4 = await request(app).post('/api/trades').set(auth()).send({ symbol: 'ZZZZ', side: 'BUY', quantity: 1 });
    expect(r4.status).toBe(404);
    const r5 = await request(app).post('/api/trades').set('Content-Type', 'application/json').set(auth()).send('{bad json');
    expect(r5.status).toBe(400);
  });

  test('protects private endpoints', async () => {
    expect((await request(app).get('/api/portfolio')).status).toBe(401);
    expect((await request(app).get('/api/portfolio').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  test('serves quotes and historical analytics', async () => {
    const all = await request(app).get('/api/stocks');
    expect(all.body.quotes.length).toBe(config.symbols.length);
    const one = await request(app).get('/api/stocks/aapl');
    expect(one.body.quote.symbol).toBe('AAPL');

    const h = await request(app).get('/api/stocks/MSFT/history?range=3M');
    expect(h.status).toBe(200);
    expect(h.body.bars.length).toBeGreaterThan(55);
    expect(h.body.bars.at(-1).sma50).not.toBeNull();
    expect(h.body.stats.annualizedVolatilityPct).toBeGreaterThan(0);
  });

  test('buys and sells, tracking cash, cost basis, and realized P&L', async () => {
    const price = market.quote('NVDA').price;
    const buy = await request(app).post('/api/trades').set(auth()).send({ symbol: 'NVDA', side: 'BUY', quantity: 10 });
    expect(buy.status).toBe(201);
    expect(buy.body.transaction.total).toBeCloseTo(price * 10, 2);

    let pf = await request(app).get('/api/portfolio').set(auth());
    expect(pf.body.positions).toHaveLength(1);
    expect(pf.body.positions[0].quantity).toBe(10);
    expect(pf.body.cash).toBeCloseTo(config.startingCash - price * 10, 2);

    const tooMany = await request(app).post('/api/trades').set(auth()).send({ symbol: 'NVDA', side: 'SELL', quantity: 11 });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe('INSUFFICIENT_SHARES');

    market.quotes.get('NVDA').price = price + 5; // move the market
    const sell = await request(app).post('/api/trades').set(auth()).send({ symbol: 'NVDA', side: 'SELL', quantity: 4 });
    expect(sell.status).toBe(201);
    expect(sell.body.transaction.realizedPnl).toBeCloseTo(20, 1);

    pf = await request(app).get('/api/portfolio').set(auth());
    expect(pf.body.positions[0].quantity).toBe(6);
    expect(pf.body.positions[0].costBasis).toBeCloseTo(price * 6, 1);

    const all = await request(app).post('/api/trades').set(auth()).send({ symbol: 'NVDA', side: 'SELL', quantity: 6 });
    expect(all.status).toBe(201);
    pf = await request(app).get('/api/portfolio').set(auth());
    expect(pf.body.positions).toHaveLength(0);
  });

  test('rejects buys beyond available cash, even when sent concurrently', async () => {
    const reg = await request(app).post('/api/auth/register').send({ username: 'racer', password: 'racer-password' });
    const t = { Authorization: `Bearer ${reg.body.token}` };
    const q = market.quote('MSFT');
    // each order costs ~40% of the cash, so at most 2 of 5 parallel orders can fill
    const qty = Math.floor((config.startingCash * 0.4) / q.price);
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      request(app).post('/api/trades').set(t).send({ symbol: 'MSFT', side: 'BUY', quantity: qty })));
    const filled = results.filter((r) => r.status === 201).length;
    expect(filled).toBe(2);
    expect(results.filter((r) => r.body.error?.code === 'INSUFFICIENT_FUNDS')).toHaveLength(3);
    const pf = await request(app).get('/api/portfolio').set(t);
    expect(pf.body.cash).toBeGreaterThanOrEqual(0);
    expect(pf.body.positions[0].quantity).toBe(qty * 2);
  });

  test('logs transactions with filtering and pagination', async () => {
    const r = await request(app).get('/api/transactions?limit=2').set(auth());
    expect(r.body.total).toBe(3);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].side).toBe('SELL');
    const f = await request(app).get('/api/transactions?symbol=AAPL').set(auth());
    expect(f.body.total).toBe(0);
  });

  test('streams live quotes over SSE', async () => {
    const server = app.listen(0);
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/stream?symbols=AAPL`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body.getReader();
    market.step();
    let text = '';
    while (!text.includes('event: tick')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"symbol":"AAPL"');
    await reader.cancel();
    server.close();
  });
});
