// Local end-to-end check of api/index.mjs (the Vercel entry) WITHOUT Vercel: a mock OpenAI-compatible upstream, the handler behind a plain http server,
// configuration only from env. Run after `npm run build -w server`:  node scripts/vercel-smoke.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const upstreamHits = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    upstreamHits.push({ url: req.url, auth: req.headers.authorization, body });
    if (body.includes('"stream":true')) {
      res.setHeader('content-type', 'text/event-stream');
      const chunk = (d, fin) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta: d, finish_reason: fin }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'stream ' }, null));
      res.write(chunk({ content: 'ok' }, null));
      res.write(chunk({}, 'stop'));
      return res.end('data: [DONE]\n\n');
    }
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    res.end(JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong from mock upstream' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

const unifiedKey = `freellmapi-${crypto.randomBytes(12).toString('hex')}`;
process.env.NODE_ENV = 'production';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.FREEAPI_DB_PATH = `/tmp/freellmapi-smoke-${process.pid}.db`;
process.env.FREELLMAPI_FIXED_UNIFIED_KEY = unifiedKey;
process.env.FREEAPI_CONFIG_JSON = JSON.stringify({
  admin: { email: 'owner@example.test', password: 'a-long-enough-password' },
  customProviders: [{ baseUrl: upstreamUrl, apiKey: 'mock-upstream-key', label: 'mock', models: ['mock-model'] }],
});

const bootStart = Date.now();
const { default: handler } = await import('../api/index.mjs');
const server = http.createServer((req, res) => handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (path, init = {}) => {
  const r = await fetch(base + path, init);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, text, json };
};
const bearer = { authorization: `Bearer ${unifiedKey}`, 'content-type': 'application/json' };

try {
  const ping = await call('/api/ping');
  const bootMs = Date.now() - bootStart;
  assert.equal(ping.status, 200, `ping: ${ping.status} ${ping.text.slice(0, 200)}`);

  for (const path of ['/', '/api/keys', '/api/auth/setup', '/api/settings']) {
    const blocked = await call(path);
    assert.equal(blocked.status, 404, `${path} must not be reachable on the serverless entry, got ${blocked.status}`);
  }

  const noAuth = await call('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'ping' }] }) });
  assert.ok([401, 403].includes(noAuth.status), `a request without the unified key must be refused, got ${noAuth.status}`);

  const wrong = await call('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'ping' }] }) });
  assert.ok([401, 403].includes(wrong.status), `a wrong key must be refused, got ${wrong.status}`);

  const chat = await call('/v1/chat/completions', { method: 'POST', headers: bearer, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }) });
  assert.equal(chat.status, 200, `chat: ${chat.status} ${chat.text.slice(0, 300)}`);
  assert.equal(chat.json.choices[0].message.content, 'pong from mock upstream');
  assert.ok(upstreamHits.some((h) => h.url.endsWith('/chat/completions') && h.auth === 'Bearer mock-upstream-key'), 'the call was routed to the configured upstream with the configured key');

  const stream = await call('/v1/chat/completions', { method: 'POST', headers: bearer, body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }) });
  assert.equal(stream.status, 200, `stream: ${stream.status} ${stream.text.slice(0, 300)}`);
  assert.match(stream.text, /data: \[DONE\]/);
  const streamed = [...stream.text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join('');
  assert.equal(streamed, 'stream ok', `streamed text: ${streamed}`);

  console.log(`boot+first request took ${bootMs} ms`);
  console.log('OK: ping, auth refusal, one routed chat completion and one streamed completion all passed');
} finally {
  server.close(); upstream.close();
}
