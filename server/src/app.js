const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('./config');
const errors = require('./errors');
const schemas = require('./schemas');
const { validate, requireAuth, asyncHandler, errorHandler } = require('./middleware');
const { sma, rsi, summarize, round } = require('./services/analytics');

const RANGE_DAYS = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366 };

/**
 * Builds the Express app.
 * @param {object} deps.store   storage implementation (MongoStore | MemoryStore)
 * @param {MarketSimulator} deps.market
 */
function createApp({ store, market, logRequests = true }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'script-src': ["'self'"] },
      },
    }),
  );
  app.use(express.json({ limit: '10kb' }));
  if (logRequests) app.use(morgan('dev'));

  const api = express.Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false });
  const tradeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

  const requireSymbol = (sym) => {
    const q = market.quote(sym);
    if (!q) throw errors.notFound(`Unknown symbol ${sym}`);
    return q;
  };

  // ---------------------------------------------------------------- auth
  const issueToken = (user) => jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

  api.post('/auth/register', authLimiter, validate(schemas.credentials), asyncHandler(async (req, res) => {
    const { username, password } = req.valid.body;
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await store.createUser({ username, passwordHash, cash: config.startingCash });
    res.status(201).json({ token: issueToken(user), user });
  }));

  api.post('/auth/login', authLimiter, validate(schemas.credentials), asyncHandler(async (req, res) => {
    const { username, password } = req.valid.body;
    const user = await store.findUserByUsername(username);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw errors.unauthorized('Invalid username or password');
    }
    const { passwordHash, ...pub } = user;
    res.json({ token: issueToken(pub), user: pub });
  }));

  api.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const user = await store.findUserById(req.userId);
    if (!user) throw errors.unauthorized();
    res.json({ user });
  }));

  // ---------------------------------------------------------------- market data
  api.get('/stocks', (req, res) => res.json({ quotes: market.allQuotes() }));

  api.get('/stocks/:symbol', validate(schemas.symbolParam, 'params'), (req, res) => {
    res.json({ quote: requireSymbol(req.valid.params.symbol) });
  });

  api.get('/stocks/:symbol/history',
    validate(schemas.symbolParam, 'params'), validate(schemas.historyQuery, 'query'),
    asyncHandler(async (req, res) => {
      const { symbol } = req.valid.params;
      const { range } = req.valid.query;
      requireSymbol(symbol);
      // fetch extra days so the 50-day SMA is defined from the start of the range
      const from = new Date(Date.now() - (RANGE_DAYS[range] + 80) * 86400000).toISOString().slice(0, 10);
      const all = await store.getBars(symbol, from);
      const closes = all.map((b) => b.close);
      const sma20 = sma(closes, 20);
      const sma50 = sma(closes, 50);
      const rsi14 = rsi(closes, 14);
      const cutoff = new Date(Date.now() - RANGE_DAYS[range] * 86400000).toISOString().slice(0, 10);
      const bars = [];
      all.forEach((b, i) => {
        if (b.date >= cutoff) bars.push({ ...b, sma20: sma20[i], sma50: sma50[i], rsi14: rsi14[i] });
      });
      res.json({ symbol, range, bars, stats: summarize(bars) });
    }));

  /** Server-Sent Events stream of live quotes. Optional ?symbols=AAPL,MSFT filter. */
  api.get('/stream', (req, res) => {
    const filter = req.query.symbols
      ? new Set(String(req.query.symbols).toUpperCase().split(',').filter(Boolean))
      : null;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`event: snapshot\ndata: ${JSON.stringify(market.allQuotes())}\n\n`);
    const onTick = (q) => {
      if (!filter || filter.has(q.symbol)) res.write(`event: tick\ndata: ${JSON.stringify(q)}\n\n`);
    };
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    market.on('tick', onTick);
    req.on('close', () => {
      clearInterval(keepAlive);
      market.off('tick', onTick);
    });
  });

  // ---------------------------------------------------------------- trading
  api.post('/trades', requireAuth, tradeLimiter, validate(schemas.trade), asyncHandler(async (req, res) => {
    const { symbol, side, quantity } = req.valid.body;
    const { price } = requireSymbol(symbol); // fill at the current simulated market price
    const args = { userId: req.userId, symbol, quantity, price };
    const tx = side === 'BUY' ? await store.buy(args) : await store.sell(args);
    res.status(201).json({ transaction: tx });
  }));

  api.get('/portfolio', requireAuth, asyncHandler(async (req, res) => {
    const user = await store.findUserById(req.userId);
    if (!user) throw errors.unauthorized();
    const positions = (await store.getPositions(req.userId)).map((p) => {
      const q = market.quote(p.symbol);
      const price = q ? q.price : 0;
      const marketValue = round(p.quantity * price);
      const avgCost = round(p.costBasis / p.quantity, 4);
      return {
        symbol: p.symbol,
        name: q ? q.name : p.symbol,
        quantity: p.quantity,
        avgCost,
        price,
        marketValue,
        costBasis: p.costBasis,
        unrealizedPnl: round(marketValue - p.costBasis),
        unrealizedPnlPct: p.costBasis ? round(((marketValue - p.costBasis) / p.costBasis) * 100) : 0,
        dayChangePct: q ? q.changePct : 0,
      };
    });
    const invested = round(positions.reduce((a, p) => a + p.marketValue, 0));
    const totalValue = round(user.cash + invested);
    positions.forEach((p) => { p.weightPct = totalValue ? round((p.marketValue / totalValue) * 100) : 0; });
    res.json({
      cash: user.cash,
      invested,
      totalValue,
      startingCash: config.startingCash,
      totalReturnPct: round(((totalValue - config.startingCash) / config.startingCash) * 100),
      positions,
    });
  }));

  api.get('/transactions', requireAuth, validate(schemas.txQuery, 'query'), asyncHandler(async (req, res) => {
    res.json(await store.listTransactions(req.userId, req.valid.query));
  }));

  api.get('/health', (req, res) => res.json({ ok: true, storage: config.storage }));

  app.use('/api', api);
  app.use('/api', (req, res, next) => next(errors.notFound('No such endpoint')));

  // ---------------------------------------------------------------- static AngularJS client
  const nm = path.join(__dirname, '..', 'node_modules');
  app.use('/vendor/angular', express.static(path.join(nm, 'angular')));
  app.use('/vendor/angular-route', express.static(path.join(nm, 'angular-route')));
  app.use('/vendor/bootstrap', express.static(path.join(nm, 'bootstrap', 'dist')));
  app.use('/vendor/chart.js', express.static(path.join(nm, 'chart.js', 'dist')));
  app.use(express.static(path.join(__dirname, '..', '..', 'client')));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
