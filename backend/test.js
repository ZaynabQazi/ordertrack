// Quick end-to-end smoke test: node test.js (starts its own server on port 3999)
process.env.PORT = 3999;
const { server } = require('./server');
const { io } = require('socket.io-client');
const B = 'http://localhost:3999';
const j = (p, o) => fetch(B + p, { headers: { 'Content-Type': 'application/json' }, ...o }).then(async (r) => ({ s: r.status, b: r.status === 204 ? null : await r.json() }));
const rpc = (body) => j('/rpc', { method: 'POST', body: JSON.stringify(body) });
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) process.exitCode = 1; };

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  ok('catalog', (await j('/api/v1/catalog')).b.length === 6);
  const bad = await j('/api/v1/orders', { method: 'POST', body: JSON.stringify({ customerName: 'x', items: [] }) });
  ok('validation 400', bad.s === 400);
  const created = await j('/api/v1/orders', { method: 'POST', body: JSON.stringify({ customerName: 'Ali', items: [{ productId: 1, qty: 2 }] }) });
  ok('create order 201 + total', created.s === 201 && created.b.total === 1300);
  const id = created.b.id;

  // SSE
  const sse = await fetch(B + '/events');
  const reader = sse.body.getReader(); let sseText = '';
  (async () => { const d = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) break; sseText += d.decode(value); } })();

  // sockets
  const cust = io(B), agent = io(B), agent2 = io(B);
  const got = {};
  cust.on('order:status', (d) => (got.status = d.status));
  cust.on('chat:message', (m) => (got.custMsg = m.text));
  agent.on('chat:message', (m) => (got.agentMsg = m.text));
  agent2.on('chat:error', (e) => (got.err = e.message));
  await new Promise((r) => setTimeout(r, 300));
  cust.emit('order:subscribe', id);
  agent.emit('agent:join');
  cust.emit('chat:join', { orderId: id, role: 'customer', name: 'Ali' });
  agent.emit('chat:join', { orderId: id, role: 'agent', name: 'Sara' });
  agent2.emit('chat:join', { orderId: id, role: 'agent', name: 'Extra' });
  await new Promise((r) => setTimeout(r, 300));
  ok('1-on-1 blocks 2nd agent', /already/.test(got.err || ''));
  cust.emit('chat:message', { text: 'hello' });
  await new Promise((r) => setTimeout(r, 300));
  ok('chat delivered to both', got.custMsg === 'hello' && got.agentMsg === 'hello');

  await j(`/api/v1/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'preparing' }) });
  await new Promise((r) => setTimeout(r, 300));
  ok('socket status push', got.status === 'preparing');

  ok('rpc getOrderStatus', (await rpc({ jsonrpc: '2.0', method: 'getOrderStatus', params: { orderId: id }, id: 1 })).b.result.status === 'preparing');
  ok('rpc cancel rejected when preparing', (await rpc({ jsonrpc: '2.0', method: 'cancelOrder', params: { orderId: id }, id: 2 })).b.error.code === -32005);
  ok('rpc method not found', (await rpc({ jsonrpc: '2.0', method: 'nope', id: 3 })).b.error.code === -32601);
  ok('rpc invalid request', (await rpc({ foo: 1 })).b.error.code === -32600);
  ok('rpc notification 204', (await rpc({ jsonrpc: '2.0', method: 'ping' })).s === 204);
  ok('rpc batch', (await rpc([{ jsonrpc: '2.0', method: 'ping', id: 1 }, { jsonrpc: '2.0', method: 'ping', id: 2 }])).b.length === 2);
  const raw = await fetch(B + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  ok('rpc parse error', (await raw.json()).error.code === -32700);

  const o2 = (await j('/api/v1/orders', { method: 'POST', body: JSON.stringify({ customerName: 'Bo', items: [{ productId: 2, qty: 1 }] }) })).b;
  ok('rpc cancelOrder works', (await rpc({ jsonrpc: '2.0', method: 'cancelOrder', params: { orderId: o2.id }, id: 9 })).b.result.cancelled === true);
  await new Promise((r) => setTimeout(r, 300));
  ok('sse alert received', /event: alert/.test(sseText) && /cancelled/.test(sseText));
  process.exit(process.exitCode || 0);
})();
