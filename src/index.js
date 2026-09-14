'use strict';

require('dotenv').config();

const express = require('express');
const { authenticate, requireAuth } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { buildProxy } = require('./proxy');

const PORT = process.env.PORT || 3000;
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://user-service:3002';
const CONTENT_SERVICE_URL = process.env.CONTENT_SERVICE_URL || 'http://content-service:3001';

const app = express();
app.disable('x-powered-by');

// Gateway's own health check — answered directly, never proxied.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// NOTE: intentionally no express.json()/body-parser here. Every other route
// below is a reverse proxy, and http-proxy-middleware streams the original
// request body straight through to the downstream service; parsing it here
// would consume the stream and break proxying of POST/PATCH bodies.

// Runs on every request from here down: records auth info on req.auth but
// never blocks by itself (see src/middleware/auth.js for the full contract).
app.use(authenticate);

const userServiceProxy = buildProxy(USER_SERVICE_URL);
const contentServiceProxy = buildProxy(CONTENT_SERVICE_URL);

// ---- user-service ----------------------------------------------------
app.post('/auth/register', userServiceProxy);
app.post('/auth/login', userServiceProxy);
app.patch('/users/:id/role', requireAuth(['ADMIN']), userServiceProxy);

// ---- content-service ---------------------------------------------------
app.get('/posts', contentServiceProxy);
app.get('/posts/:id', contentServiceProxy);
app.get('/categories', contentServiceProxy);

app.post('/posts', requireAuth(['AUTHOR', 'ADMIN']), contentServiceProxy);
app.patch('/posts/:id', requireAuth(['AUTHOR', 'ADMIN']), contentServiceProxy);
app.post('/categories', requireAuth(['AUTHOR', 'ADMIN']), contentServiceProxy);

app.post('/posts/:id/comments', requireAuth(['READER', 'AUTHOR', 'ADMIN']), contentServiceProxy);
app.patch('/comments/:id', requireAuth(['READER', 'AUTHOR', 'ADMIN']), contentServiceProxy);
app.delete('/comments/:id', requireAuth(['READER', 'AUTHOR', 'ADMIN']), contentServiceProxy);

// ---- convenience pass-throughs (optional, trivial to add) --------------
app.get('/user-service/health', buildProxy(USER_SERVICE_URL, { pathRewrite: { '^/user-service': '' } }));
app.get('/content-service/health', buildProxy(CONTENT_SERVICE_URL, { pathRewrite: { '^/content-service': '' } }));

// Anything else -> standardized 404, then the catch-all error handler.
app.use(notFoundHandler);
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[gateway] listening on port ${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[gateway] -> user-service:    ${USER_SERVICE_URL}`);
    // eslint-disable-next-line no-console
    console.log(`[gateway] -> content-service: ${CONTENT_SERVICE_URL}`);
  });
}

module.exports = app;
