const mongoose = require('mongoose');
const errors = require('../errors');

const round2 = (x) => Math.round(x * 100) / 100;

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true },
    usernameLower: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    cash: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

const positionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  symbol: { type: String, required: true },
  quantity: { type: Number, required: true, min: 0 },
  costBasis: { type: Number, required: true },
});
positionSchema.index({ userId: 1, symbol: 1 }, { unique: true });

const transactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    symbol: { type: String, required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    total: { type: Number, required: true },
    realizedPnl: { type: Number, default: 0 },
    cashAfter: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, symbol: 1, createdAt: -1 });

const barSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  open: Number,
  high: Number,
  low: Number,
  close: Number,
  volume: Number,
});
barSchema.index({ symbol: 1, date: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);
const Position = mongoose.model('Position', positionSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const DailyBar = mongoose.model('DailyBar', barSchema);

const txOut = (t) => ({
  id: String(t._id),
  userId: String(t.userId),
  symbol: t.symbol,
  side: t.side,
  quantity: t.quantity,
  price: t.price,
  total: t.total,
  realizedPnl: t.realizedPnl,
  cashAfter: t.cashAfter,
  createdAt: t.createdAt,
});

/**
 * MongoDB implementation. Trades stay consistent without multi-document transactions
 * (so it also works on a standalone mongod): each step is a single conditional
 * atomic update, and the first step is rolled back if the second one fails.
 */
class MongoStore {
  constructor(uri) {
    this.uri = uri;
  }

  async init() {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(this.uri, { serverSelectionTimeoutMS: 10000 });
    }
    // createIndexes (not init, which is memoized) so indexes exist even after a DB drop
    await Promise.all([User, Position, Transaction, DailyBar].map((m) => m.createIndexes()));
  }

  async dropAll() {
    await mongoose.connection.db.dropDatabase();
    await this.init();
  }

  async close() {
    await mongoose.disconnect();
  }

  publicUser(u) {
    return u && { id: String(u._id), username: u.username, cash: u.cash, createdAt: u.createdAt };
  }

  async createUser({ username, passwordHash, cash }) {
    try {
      const u = await User.create({ username, usernameLower: username.toLowerCase(), passwordHash, cash });
      return this.publicUser(u);
    } catch (e) {
      if (e.code === 11000) throw errors.conflict('Username already taken');
      throw e;
    }
  }

  async findUserByUsername(username) {
    const u = await User.findOne({ usernameLower: username.toLowerCase() }).lean();
    return u && { ...this.publicUser(u), passwordHash: u.passwordHash };
  }

  async findUserById(id) {
    if (!mongoose.isValidObjectId(id)) return null;
    return this.publicUser(await User.findById(id).lean());
  }

  async buy({ userId, symbol, quantity, price }) {
    const total = round2(quantity * price);
    // 1) atomically take the cash only if the balance covers it
    const user = await User.findOneAndUpdate(
      { _id: userId, cash: { $gte: total } },
      { $inc: { cash: -total } },
      { returnDocument: 'after' },
    ).lean();
    if (!user) {
      if (!(await User.exists({ _id: userId }))) throw errors.notFound('User not found');
      throw errors.insufficientFunds();
    }
    try {
      // 2) add shares (upsert creates the position on the first buy)
      await Position.updateOne(
        { userId, symbol },
        { $inc: { quantity, costBasis: total } },
        { upsert: true },
      );
    } catch (e) {
      await User.updateOne({ _id: userId }, { $inc: { cash: total } }); // compensate
      throw e;
    }
    const tx = await Transaction.create({
      userId, symbol, side: 'BUY', quantity, price, total, realizedPnl: 0, cashAfter: round2(user.cash),
    });
    return txOut(tx);
  }

  async sell({ userId, symbol, quantity, price }) {
    const total = round2(quantity * price);
    // 1) atomically remove shares only if enough are held; cost basis shrinks pro rata
    const before = await Position.findOneAndUpdate(
      { userId, symbol, quantity: { $gte: quantity } },
      [
        {
          $set: {
            costBasis: {
              $round: [
                { $subtract: ['$costBasis', { $multiply: [{ $divide: ['$costBasis', '$quantity'] }, quantity] }] },
                2,
              ],
            },
            quantity: { $subtract: ['$quantity', quantity] },
          },
        },
      ],
      { returnDocument: 'before' },
    ).lean();
    if (!before) throw errors.insufficientShares();
    const avgCost = before.costBasis / before.quantity;

    let user;
    try {
      // 2) credit the cash
      user = await User.findOneAndUpdate({ _id: userId }, { $inc: { cash: total } }, { returnDocument: 'after' }).lean();
      if (!user) throw errors.notFound('User not found');
    } catch (e) {
      await Position.updateOne(
        { userId, symbol },
        { $inc: { quantity, costBasis: round2(avgCost * quantity) } },
      ); // compensate
      throw e;
    }
    await Position.deleteOne({ userId, symbol, quantity: 0 });
    const tx = await Transaction.create({
      userId,
      symbol,
      side: 'SELL',
      quantity,
      price,
      total,
      realizedPnl: round2((price - avgCost) * quantity),
      cashAfter: round2(user.cash),
    });
    return txOut(tx);
  }

  async getPositions(userId) {
    const rows = await Position.find({ userId, quantity: { $gt: 0 } }).sort({ symbol: 1 }).lean();
    return rows.map((p) => ({ symbol: p.symbol, quantity: p.quantity, costBasis: p.costBasis }));
  }

  async listTransactions(userId, { symbol, limit = 50, skip = 0 } = {}) {
    const q = { userId };
    if (symbol) q.symbol = symbol;
    const [total, rows] = await Promise.all([
      Transaction.countDocuments(q),
      Transaction.find(q).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    ]);
    return { total, items: rows.map(txOut) };
  }

  async barCount(symbol) {
    return DailyBar.countDocuments({ symbol });
  }

  async saveBars(symbol, bars) {
    if (!bars.length) return;
    await DailyBar.bulkWrite(
      bars.map((b) => ({
        updateOne: { filter: { symbol, date: b.date }, update: { $set: b }, upsert: true },
      })),
      { ordered: false },
    );
  }

  async getBars(symbol, fromDate) {
    const q = { symbol };
    if (fromDate) q.date = { $gte: fromDate };
    const rows = await DailyBar.find(q).sort({ date: 1 }).lean();
    return rows.map(({ symbol: s, date, open, high, low, close, volume }) => ({
      symbol: s, date, open, high, low, close, volume,
    }));
  }
}

module.exports = { MongoStore };
