const { z } = require('zod');

const symbol = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{1,5}$/, 'Symbol must be 1-5 letters');

const credentials = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'At least 3 characters')
    .max(30)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Letters, numbers, _ . - only'),
  password: z.string().min(8, 'At least 8 characters').max(128),
});

const trade = z.object({
  symbol,
  side: z.enum(['BUY', 'SELL']),
  quantity: z.coerce.number().int('Whole shares only').positive().max(1_000_000),
});

const historyQuery = z.object({
  range: z.enum(['1M', '3M', '6M', '1Y']).default('6M'),
});

const txQuery = z.object({
  symbol: symbol.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

const symbolParam = z.object({ symbol });

module.exports = { credentials, trade, historyQuery, txQuery, symbolParam };
