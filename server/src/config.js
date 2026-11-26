require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  // "mongo" (default) or "memory" (no database needed — handy for demos and tests)
  storage: process.env.STORAGE || 'mongo',
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/stocksim',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  startingCash: parseFloat(process.env.STARTING_CASH || '100000'),
  tickIntervalMs: parseInt(process.env.TICK_INTERVAL_MS || '1000', 10),
  historyDays: parseInt(process.env.HISTORY_DAYS || '365', 10),
  symbols: (process.env.SYMBOLS || 'AAPL,MSFT,GOOGL,AMZN,NVDA,TSLA,META,NFLX,AMD,INTC').split(','),
};

if (process.env.NODE_ENV === 'production' && config.jwtSecret === 'dev-only-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = config;
