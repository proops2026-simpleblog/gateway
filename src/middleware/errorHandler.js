'use strict';

/**
 * Standardized error payload used for every 401/403/404/5xx the gateway
 * itself generates (per IRD-003):
 *   { error, message, statusCode, timestamp }
 */
function sendError(res, statusCode, error, message) {
  return res.status(statusCode).json({
    error,
    message,
    statusCode,
    timestamp: new Date().toISOString(),
  });
}

// Mounted last: catches any request that didn't match a known route.
function notFoundHandler(req, res) {
  sendError(
    res,
    404,
    'Not Found',
    `Route ${req.method} ${req.originalUrl} does not exist on this gateway`
  );
}

// Express error-handling middleware (4-arg signature required by Express).
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // eslint-disable-next-line no-console -- the only log line for unhandled errors
  console.error('[gateway] unhandled error:', err);
  const statusCode = err.statusCode || 502;
  const error = err.error || (statusCode === 502 ? 'Bad Gateway' : 'Internal Server Error');
  const message = err.message || 'Unexpected error while handling the request';
  sendError(res, statusCode, error, message);
}

module.exports = { sendError, notFoundHandler, errorHandler };
