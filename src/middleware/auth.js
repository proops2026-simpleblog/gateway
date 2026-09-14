'use strict';

const jwt = require('jsonwebtoken');
const { sendError } = require('./errorHandler');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  // Fail fast: a gateway that silently accepts an undefined secret would
  // "verify" any token. Never run with a missing secret.
  // eslint-disable-next-line no-console
  console.warn('[gateway] WARNING: JWT_SECRET is not set. Set it via environment/.env.');
}

/**
 * Global middleware, mounted before any route. Runs on EVERY request
 * (public or protected) and never rejects a request on its own — it only
 * records what it found on req.auth for downstream middleware/proxies to use:
 *
 *   req.auth.presented      -> an Authorization header was sent at all
 *   req.auth.headerMalformed -> header present but not "Bearer <token>"
 *   req.auth.valid           -> token present, well-formed, verified (sig + exp)
 *   req.auth.payload         -> decoded JWT payload when valid === true
 *
 * Steps 1-2 (extract) happen here; verification (step 3) also happens here
 * since it must run regardless of whether the route is public, so that a
 * public route can still forward identity when a good token is presented.
 * Whether a bad/missing token actually blocks the request is decided by
 * requireAuth() below, per-route.
 */
function authenticate(req, res, next) {
  req.auth = { presented: false, headerMalformed: false, valid: false, payload: null };

  const header = req.headers['authorization'];
  if (!header) {
    return next();
  }

  req.auth.presented = true;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) {
    req.auth.headerMalformed = true;
    return next();
  }

  const token = match[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.auth.valid = true;
    req.auth.payload = payload;
  } catch (err) {
    // Invalid signature, expired, malformed JWT, etc. Leave valid = false;
    // requireAuth() decides whether that matters for this route.
    req.auth.valid = false;
  }

  next();
}

/**
 * Route-level guard factory. Apply to any route that requires auth.
 *   requireAuth()                       -> any authenticated user
 *   requireAuth(['ADMIN'])              -> only ADMIN
 *   requireAuth(['AUTHOR', 'ADMIN'])    -> AUTHOR or ADMIN
 *
 * Must run after `authenticate` has populated req.auth.
 */
function requireAuth(allowedRoles = []) {
  return function (req, res, next) {
    const auth = req.auth || {};

    // Step 2: missing or malformed header on a route that requires auth -> 401.
    if (!auth.presented || auth.headerMalformed) {
      return sendError(res, 401, 'Unauthorized', 'Missing or malformed Authorization header');
    }

    // Step 3: header present but verification failed -> 401.
    if (!auth.valid) {
      return sendError(res, 401, 'Unauthorized', 'Invalid or expired token');
    }

    // Step 6: verified, but role not on the allow-list -> 403.
    if (allowedRoles.length > 0 && !allowedRoles.includes(auth.payload.role)) {
      return sendError(
        res,
        403,
        'Forbidden',
        `Role '${auth.payload.role}' is not permitted to access this resource`
      );
    }

    next();
  };
}

module.exports = { authenticate, requireAuth };
