const config = require('./config');
const { createApp } = require('./app');
const { MarketSimulator } = require('./services/marketSimulator');
const { MemoryStore } = require('./store/memoryStore');
const { MongoStore } = require('./store/mongoStore');

async function seedHistory(store, market) {
  for (const symbol of config.symbols) {
    const bars = market.generateHistory(symbol, config.historyDays);
    // keep stored history if present; otherwise seed it (bars are deterministic per symbol)
    if ((await store.barCount(symbol)) < bars.length / 2) await store.saveBars(symbol, bars);
  }
}

async function main() {
  const store = config.storage === 'memory' ? new MemoryStore() : new MongoStore(config.mongoUri);
  await store.init();
  const market = new MarketSimulator(config.symbols, { tickIntervalMs: config.tickIntervalMs });
  await seedHistory(store, market);
  market.start();

  const app = createApp({ store, market });
  const server = app.listen(config.port, () => {
    console.log(`Stock Trading Simulator on http://localhost:${config.port}  (storage: ${config.storage})`);
  });

  const shutdown = async () => {
    market.stop();
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Failed to start:', e.message);
    process.exit(1);
  });
}

module.exports = { seedHistory };
