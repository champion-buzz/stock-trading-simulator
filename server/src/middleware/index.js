const jwt = require('jsonwebtoken');
const { ZodError } = require('zod');
const config = require('../config');
const errors = require('../errors');
const { AppError } = require('../errors');

/** Validates req[part] against a zod schema and replaces it with the parsed value. */
const validate = (schema, part = 'body') => (req, res, next) => {
  const parsed = schema.safeParse(req[part] ?? {});
  if (!parsed.success) {
    return next(errors.badRequest('Validation failed',
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }))));
  }
  // req.query is a getter in Express 5, so keep the parsed copy on req.valid
  req.valid = { ...(req.valid || {}), [part]: parsed.data };
  return next();
};

/** Requires "Authorization: Bearer <jwt>" (or ?token= for EventSource, which can't set headers). */
const requireAuth = (req, res, next) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return next(errors.unauthorized());
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.userId = payload.sub;
    return next();
  } catch {
    return next(errors.unauthorized('Invalid or expired token'));
  }
};

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Validation failed' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
};

module.exports = { validate, requireAuth, asyncHandler, errorHandler };
