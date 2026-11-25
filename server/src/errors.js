class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const errors = {
  badRequest: (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details),
  unauthorized: (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg),
  notFound: (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg) => new AppError(409, 'CONFLICT', msg),
  insufficientFunds: () => new AppError(422, 'INSUFFICIENT_FUNDS', 'Not enough cash for this order'),
  insufficientShares: () => new AppError(422, 'INSUFFICIENT_SHARES', 'Not enough shares to sell'),
};

module.exports = { AppError, ...errors };
