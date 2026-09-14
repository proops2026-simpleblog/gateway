'use strict';

const { createProxyMiddleware } = require('http-proxy-middleware');

/**
 * Builds a reverse-proxy middleware for one downstream service.
 *
 * Forwards method/body/headers as-is (http-proxy-middleware streams the
 * original request), and additionally injects X-User-Id / X-User-Role when
 * `authenticate` (src/middleware/auth.js) verified a JWT on this request.
 * Downstream services (user-service, content-service) trust these headers
 * because they are only reachable via the internal Docker network — the
 * gateway is the sole entry point for API traffic.
 *
 * @param {string} target - base URL of the downstream service, e.g. http://user-service:3002
 * @param {object} [options] - extra http-proxy-middleware options (e.g. pathRewrite)
 */
function buildProxy(target, options = {}) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    logLevel: 'silent',
    onProxyReq(proxyReq, req) {
      if (req.auth && req.auth.valid && req.auth.payload) {
        const { sub, role } = req.auth.payload;
        if (sub !== undefined && sub !== null) {
          proxyReq.setHeader('X-User-Id', String(sub));
        }
        if (role !== undefined && role !== null) {
          proxyReq.setHeader('X-User-Role', String(role));
        }
      }
    },
    onError(err, req, res) {
      // Downstream unreachable/timed out — surface as a standardized 502
      // rather than letting the connection hang or leak a stack trace.
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Bad Gateway',
          message: `Upstream service (${target}) is unavailable: ${err.message}`,
          statusCode: 502,
          timestamp: new Date().toISOString(),
        });
      }
    },
    ...options,
  });
}

module.exports = { buildProxy };
