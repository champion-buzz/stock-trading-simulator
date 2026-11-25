const crypto = require('crypto');
const errors = require('../errors');

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * In-memory implementation of the store interface. Same behaviour as MongoStore;
 * used for tests and for running the demo without a database (STORAGE=memory).
 * Node's single thread makes each method atomic.
 */
class MemoryStore {
  constructor() {
    this.users = new Map();
    this.positions = new Map(); // `${userId}:${symbol}` -> { quantity, costBasis }
    this.transactions = [];
    this.bars = new Map(); // symbol -> [bars]
  }

  async init() {}

  async close() {}

  publicUser(u) {
    return u && { id: u.id, username: u.username, cash: u.cash, createdAt: u.createdAt };
  }

  async createUser({ username, passwordHash, cash }) {
    const key = username.toLowerCase();
    if ([...this.users.values()].some((u) => u.username.toLowerCase() === key)) {
      throw errors.conflict('Username already taken');
    }
    const user = { id: crypto.randomUUID(), username, passwordHash, cash, createdAt: new Date() };
    this.users.set(user.id, user);
    return this.publicUser(user);
  }

  async findUserByUsername(username) {
    const key = username.toLowerCase();
    return [...this.users.values()].find((u) => u.username.toLowerCase() === key) || null;
  }

  async findUserById(id) {
    return this.publicUser(this.users.get(id)) || null;
  }

  async buy({ userId, symbol, quantity, price }) {
    const user = this.users.get(userId);
    if (!user) throw errors.notFound('User not found');
    const total = round2(quantity * price);
    if (user.cash < total) throw errors.insufficientFunds();
    user.cash = round2(user.cash - total);
    const key = `${userId}:${symbol}`;
    const pos = this.positions.get(key) || { quantity: 0, costBasis: 0 };
    pos.quantity += quantity;
    pos.costBasis = round2(pos.costBasis + total);
    this.positions.set(key, pos);
    return this.record({ userId, symbol, side: 'BUY', quantity, price, total, realizedPnl: 0, cashAfter: user.cash });
  }

  async sell({ userId, symbol, quantity, price }) {
    const user = this.users.get(userId);
    if (!user) throw errors.notFound('User not found');
    const key = `${userId}:${symbol}`;
    const pos = this.positions.get(key);
    if (!pos || pos.quantity < quantity) throw errors.insufficientShares();
    const avgCost = pos.costBasis / pos.quantity;
    const total = round2(quantity * price);
    pos.quantity -= quantity;
    pos.costBasis = pos.quantity === 0 ? 0 : round2(pos.costBasis - avgCost * quantity);
    if (pos.quantity === 0) this.positions.delete(key);
    user.cash = round2(user.cash + total);
    const realizedPnl = round2((price - avgCost) * quantity);
    return this.record({ userId, symbol, side: 'SELL', quantity, price, total, realizedPnl, cashAfter: user.cash });
  }

  record(tx) {
    const t = { id: crypto.randomUUID(), ...tx, createdAt: new Date() };
    this.transactions.push(t);
    return t;
  }

  async getPositions(userId) {
    const out = [];
    for (const [key, p] of this.positions) {
      const [uid, symbol] = key.split(':');
      if (uid === userId && p.quantity > 0) out.push({ symbol, quantity: p.quantity, costBasis: p.costBasis });
    }
    return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async listTransactions(userId, { symbol, limit = 50, skip = 0 } = {}) {
    const all = this.transactions
      .filter((t) => t.userId === userId && (!symbol || t.symbol === symbol))
      .sort((a, b) => b.createdAt - a.createdAt);
    return { total: all.length, items: all.slice(skip, skip + limit) };
  }

  async barCount(symbol) {
    return (this.bars.get(symbol) || []).length;
  }

  async saveBars(symbol, bars) {
    this.bars.set(symbol, bars.slice());
  }

  async getBars(symbol, fromDate) {
    return (this.bars.get(symbol) || []).filter((b) => !fromDate || b.date >= fromDate);
  }
}

module.exports = { MemoryStore };
