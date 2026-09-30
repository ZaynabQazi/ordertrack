const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ORIGINS = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((s) => s.trim())
  : '*';

const app = express();
app.use(cors({ origin: ORIGINS }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGINS } });

/* ------------------------------------------------------------------ */
/* In-memory data                                                      */
/* ------------------------------------------------------------------ */
const STATUSES = ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];

const catalog = [
  { id: 1, name: 'Zinger Burger', price: 650 },
  { id: 2, name: 'Chicken Biryani', price: 550 },
  { id: 3, name: 'Club Sandwich', price: 480 },
  { id: 4, name: 'Loaded Fries', price: 350 },
  { id: 5, name: 'Chocolate Shake', price: 400 },
  { id: 6, name: 'Cold Coffee', price: 380 },
];

const orders = new Map();
const chats = new Map(); // orderId -> [messages]
let nextOrderId = 1001;

/* ------------------------------------------------------------------ */
/* SSE (Server-Sent Events) : /events                                  */
/* ------------------------------------------------------------------ */
const sseClients = new Set();
let sseEventId = 0;

function sseSend(res, event, data) {
  res.write(`id: ${++sseEventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastAlert(level, message, extra = {}) {
  const alert = { level, message, time: new Date().toISOString(), ...extra };
  for (const res of sseClients) sseSend(res, 'alert', alert);
  return alert;
}

app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  sseSend(res, 'connected', { message: 'Live alerts connected', clients: sseClients.size + 1 });
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// keep-alive comment so proxies (Render) don't close idle streams
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25000);

// periodic system alert so the stream visibly "lives"
setInterval(() => {
  if (sseClients.size) {
    broadcastAlert('info', `System healthy. Active orders: ${[...orders.values()].filter(isActive).length}`);
  }
}, 60000);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const isActive = (o) => !['delivered', 'cancelled'].includes(o.status);

function setStatus(order, status, by = 'system') {
  order.status = status;
  order.updatedAt = new Date().toISOString();
  order.history.push({ status, at: order.updatedAt, by });
  io.to(`order:${order.id}`).emit('order:status', { orderId: order.id, status, updatedAt: order.updatedAt });
  io.to('agents').emit('orders:changed', { orderId: order.id, status });
  broadcastAlert(status === 'cancelled' ? 'warning' : 'info', `Order #${order.id} is now "${status}"`, {
    orderId: order.id,
  });
  return order;
}

/* ------------------------------------------------------------------ */
/* REST : /api/v1                                                      */
/* ------------------------------------------------------------------ */
app.get('/', (req, res) =>
  res.json({
    name: 'Order Tracker API',
    endpoints: ['/api/v1/catalog', '/api/v1/orders', '/rpc (POST)', '/events (SSE)', '/socket.io'],
  })
);

app.get('/api/v1/catalog', (req, res) => res.json(catalog));

app.get('/api/v1/orders', (req, res) => {
  let list = [...orders.values()];
  if (req.query.status) list = list.filter((o) => o.status === req.query.status);
  if (req.query.customer) {
    const c = String(req.query.customer).toLowerCase();
    list = list.filter((o) => o.customerName.toLowerCase() === c);
  }
  res.json(list.sort((a, b) => b.id - a.id));
});

app.get('/api/v1/orders/:id', (req, res) => {
  const order = orders.get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.post('/api/v1/orders', (req, res) => {
  const { customerName, items } = req.body || {};
  if (!customerName || typeof customerName !== 'string' || !customerName.trim())
    return res.status(400).json({ error: 'customerName is required' });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'items must be a non-empty array' });

  const lines = [];
  for (const it of items) {
    const product = catalog.find((p) => p.id === Number(it.productId));
    const qty = Number(it.qty);
    if (!product) return res.status(400).json({ error: `Unknown productId ${it.productId}` });
    if (!Number.isInteger(qty) || qty < 1 || qty > 20)
      return res.status(400).json({ error: 'qty must be an integer between 1 and 20' });
    lines.push({ productId: product.id, name: product.name, price: product.price, qty });
  }

  const now = new Date().toISOString();
  const order = {
    id: nextOrderId++,
    customerName: customerName.trim(),
    items: lines,
    total: lines.reduce((s, l) => s + l.price * l.qty, 0),
    status: 'placed',
    createdAt: now,
    updatedAt: now,
    history: [{ status: 'placed', at: now, by: 'customer' }],
  };
  orders.set(order.id, order);
  io.to('agents').emit('orders:changed', { orderId: order.id, status: 'placed' });
  broadcastAlert('info', `New order #${order.id} from ${order.customerName} (Rs. ${order.total})`, {
    orderId: order.id,
  });
  res.status(201).json(order);
});

app.patch('/api/v1/orders/:id/status', (req, res) => {
  const order = orders.get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { status } = req.body || {};
  if (!STATUSES.includes(status))
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  if (!isActive(order)) return res.status(409).json({ error: `Order is already ${order.status}` });
  res.json(setStatus(order, status, 'agent'));
});

/* ------------------------------------------------------------------ */
/* JSON-RPC 2.0 : POST /rpc                                            */
/* ------------------------------------------------------------------ */
class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const rpcMethods = {
  ping: () => 'pong',

  getOrderStatus: ({ orderId } = {}) => {
    const order = orders.get(Number(orderId));
    if (!order) throw new RpcError(-32004, 'Order not found', { orderId });
    return { orderId: order.id, status: order.status, updatedAt: order.updatedAt };
  },

  cancelOrder: ({ orderId, reason } = {}) => {
    if (orderId === undefined) throw new RpcError(-32602, 'Invalid params: orderId is required');
    const order = orders.get(Number(orderId));
    if (!order) throw new RpcError(-32004, 'Order not found', { orderId });
    if (!['placed', 'confirmed'].includes(order.status))
      throw new RpcError(-32005, `Cannot cancel an order that is "${order.status}"`, { status: order.status });
    setStatus(order, 'cancelled', 'rpc');
    if (reason) order.cancelReason = String(reason).slice(0, 200);
    return { orderId: order.id, status: order.status, cancelled: true };
  },
};

async function handleRpc(msg) {
  const isValid =
    msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && typeof msg.method === 'string';
  const hasId = msg && Object.prototype.hasOwnProperty.call(msg, 'id');
  if (!isValid) return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null };

  const fn = rpcMethods[msg.method];
  if (!fn) return hasId ? { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: msg.id } : null;

  try {
    const result = await fn(msg.params || {});
    return hasId ? { jsonrpc: '2.0', result, id: msg.id } : null; // notifications get no response
  } catch (e) {
    if (!hasId) return null;
    const error = e instanceof RpcError ? { code: e.code, message: e.message, data: e.data } : { code: -32603, message: 'Internal error' };
    return { jsonrpc: '2.0', error, id: msg.id };
  }
}

app.post('/rpc', async (req, res) => {
  const body = req.body;
  if (Array.isArray(body)) {
    if (body.length === 0)
      return res.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
    const out = (await Promise.all(body.map(handleRpc))).filter(Boolean);
    return out.length ? res.json(out) : res.status(204).end();
  }
  const out = await handleRpc(body);
  return out ? res.json(out) : res.status(204).end();
});

// malformed JSON body -> Parse error
app.use((err, req, res, next) => {
  if (req.path === '/rpc' && err.type === 'entity.parse.failed')
    return res.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  next(err);
});

/* ------------------------------------------------------------------ */
/* WebSockets (Socket.io)                                              */
/* ------------------------------------------------------------------ */
// 1-on-1 chat: each order room holds at most one customer and one agent
const chatSeats = new Map(); // room -> { customer: socketId|null, agent: socketId|null }

io.on('connection', (socket) => {
  // --- live order status ---
  socket.on('order:subscribe', (orderId) => {
    const order = orders.get(Number(orderId));
    if (!order) return socket.emit('chat:error', { message: 'Order not found' });
    socket.join(`order:${order.id}`);
    socket.emit('order:status', { orderId: order.id, status: order.status, updatedAt: order.updatedAt });
  });

  socket.on('agent:join', () => {
    socket.join('agents');
    socket.emit('agent:joined', { ok: true });
  });

  // --- 1-on-1 chat ---
  socket.on('chat:join', ({ orderId, role, name } = {}) => {
    const order = orders.get(Number(orderId));
    if (!order) return socket.emit('chat:error', { message: 'Order not found' });
    if (!['customer', 'agent'].includes(role)) return socket.emit('chat:error', { message: 'Invalid role' });

    const room = `chat:${order.id}`;
    const seats = chatSeats.get(room) || { customer: null, agent: null };
    if (seats[role] && seats[role] !== socket.id)
      return socket.emit('chat:error', { message: `A ${role} is already in this chat` });

    seats[role] = socket.id;
    chatSeats.set(room, seats);
    socket.data.chat = { room, role, name: (name || role).toString().slice(0, 30), orderId: order.id };
    socket.join(room);

    socket.emit('chat:history', { orderId: order.id, messages: chats.get(order.id) || [] });
    io.to(room).emit('chat:system', { message: `${socket.data.chat.name} (${role}) joined the chat` });
  });

  socket.on('chat:message', ({ text } = {}) => {
    const c = socket.data.chat;
    if (!c) return socket.emit('chat:error', { message: 'Join a chat first' });
    const clean = String(text || '').trim().slice(0, 500);
    if (!clean) return;
    const msg = { from: c.name, role: c.role, text: clean, at: new Date().toISOString() };
    if (!chats.has(c.orderId)) chats.set(c.orderId, []);
    chats.get(c.orderId).push(msg);
    io.to(c.room).emit('chat:message', msg);
  });

  socket.on('chat:typing', (isTyping) => {
    const c = socket.data.chat;
    if (c) socket.to(c.room).emit('chat:typing', { from: c.name, isTyping: !!isTyping });
  });

  const leave = () => {
    const c = socket.data.chat;
    if (!c) return;
    const seats = chatSeats.get(c.room);
    if (seats && seats[c.role] === socket.id) seats[c.role] = null;
    socket.to(c.room).emit('chat:system', { message: `${c.name} (${c.role}) left the chat` });
    socket.leave(c.room);
    socket.data.chat = null;
  };
  socket.on('chat:leave', leave);
  socket.on('disconnect', leave);
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = { server };
