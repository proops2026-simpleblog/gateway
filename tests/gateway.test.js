'use strict';

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-secret-for-gateway-tests';
process.env.JWT_SECRET = JWT_SECRET;

let userServiceServer;
let contentServiceServer;
let app;

// A tiny stub downstream service: echoes back what it received so tests can
// assert on the exact headers/method/path/body the gateway forwarded.
function makeStub() {
  const stub = express();
  stub.use(express.json());
  stub.all('*', (req, res) => {
    res.status(200).json({
      method: req.method,
      path: req.path,
      body: req.body,
      receivedHeaders: {
        'x-user-id': req.headers['x-user-id'] || null,
        'x-user-role': req.headers['x-user-role'] || null,
      },
    });
  });
  return stub;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function signToken(payload, opts = {}) {
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h', ...opts });
}

beforeAll(async () => {
  userServiceServer = await listen(makeStub());
  contentServiceServer = await listen(makeStub());

  process.env.USER_SERVICE_URL = `http://127.0.0.1:${userServiceServer.address().port}`;
  process.env.CONTENT_SERVICE_URL = `http://127.0.0.1:${contentServiceServer.address().port}`;

  jest.resetModules();
  // eslint-disable-next-line global-require
  app = require('../src/index');
});

afterAll(async () => {
  await Promise.all([
    new Promise((resolve) => userServiceServer.close(resolve)),
    new Promise((resolve) => contentServiceServer.close(resolve)),
  ]);
});

describe('gateway health', () => {
  test('GET /health answers directly (not proxied)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('public routes', () => {
  test('GET /posts proxies without a token, no identity headers forwarded', async () => {
    const res = await request(app).get('/posts');
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('GET');
    expect(res.body.path).toBe('/posts');
    expect(res.body.receivedHeaders['x-user-id']).toBeNull();
    expect(res.body.receivedHeaders['x-user-role']).toBeNull();
  });

  test('malformed token on a public route is ignored; still proxies as anonymous', async () => {
    const res = await request(app).get('/posts').set('Authorization', 'Bearer this-is-not-a-jwt');
    expect(res.status).toBe(200);
    expect(res.body.receivedHeaders['x-user-id']).toBeNull();
    expect(res.body.receivedHeaders['x-user-role']).toBeNull();
  });

  test('valid token on a public route forwards identity headers anyway', async () => {
    const token = signToken({ sub: 'reader-1', role: 'READER' });
    const res = await request(app).get('/categories').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.receivedHeaders['x-user-id']).toBe('reader-1');
    expect(res.body.receivedHeaders['x-user-role']).toBe('READER');
  });
});

describe('protected routes', () => {
  test('POST /posts with no token -> 401 standardized error', async () => {
    const res = await request(app).post('/posts').send({ title: 'hello' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
    expect(res.body.statusCode).toBe(401);
    expect(typeof res.body.message).toBe('string');
    expect(typeof res.body.timestamp).toBe('string');
  });

  test('POST /posts with malformed token -> 401', async () => {
    const res = await request(app)
      .post('/posts')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ title: 'hello' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  test('POST /posts with an Authorization header that is not "Bearer <token>" -> 401', async () => {
    const res = await request(app).post('/posts').set('Authorization', 'Basic abc123').send({});
    expect(res.status).toBe(401);
  });

  test('POST /posts with valid AUTHOR token -> 200, X-User-Id/X-User-Role forwarded, body forwarded', async () => {
    const token = signToken({ sub: 'author-42', role: 'AUTHOR' });
    const res = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'My Post', body: 'content' });

    expect(res.status).toBe(200);
    expect(res.body.method).toBe('POST');
    expect(res.body.path).toBe('/posts');
    expect(res.body.body).toEqual({ title: 'My Post', body: 'content' });
    expect(res.body.receivedHeaders['x-user-id']).toBe('author-42');
    expect(res.body.receivedHeaders['x-user-role']).toBe('AUTHOR');
  });

  test('POST /posts with a wrong role (READER) -> 403 Forbidden', async () => {
    const token = signToken({ sub: 'reader-9', role: 'READER' });
    const res = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'nope' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
    expect(res.body.statusCode).toBe(403);
  });

  test('PATCH /users/:id/role requires ADMIN: AUTHOR is rejected with 403', async () => {
    const token = signToken({ sub: 'author-1', role: 'AUTHOR' });
    const res = await request(app)
      .patch('/users/7/role')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'AUTHOR' });
    expect(res.status).toBe(403);
  });

  test('PATCH /users/:id/role allows ADMIN and forwards identity', async () => {
    const token = signToken({ sub: 'admin-1', role: 'ADMIN' });
    const res = await request(app)
      .patch('/users/7/role')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'AUTHOR' });
    expect(res.status).toBe(200);
    expect(res.body.receivedHeaders['x-user-id']).toBe('admin-1');
    expect(res.body.receivedHeaders['x-user-role']).toBe('ADMIN');
  });

  test('POST /posts/:id/comments allows READER (broadest allow-list)', async () => {
    const token = signToken({ sub: 'reader-2', role: 'READER' });
    const res = await request(app)
      .post('/posts/5/comments')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'nice post' });
    expect(res.status).toBe(200);
    expect(res.body.receivedHeaders['x-user-id']).toBe('reader-2');
    expect(res.body.receivedHeaders['x-user-role']).toBe('READER');
  });

  test('expired token on a protected route -> 401', async () => {
    const token = signToken({ sub: 'author-3', role: 'AUTHOR' }, { expiresIn: -10 });
    const res = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('unknown routes', () => {
  test('unmatched path -> standardized 404', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not Found');
    expect(res.body.statusCode).toBe(404);
  });
});
