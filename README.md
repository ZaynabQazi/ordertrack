# Real-Time Order Tracker & Live Support System

CSC337 Lab Assignment 04. One full-stack app that uses **REST, WebSockets (Socket.io), JSON-RPC 2.0 and Server-Sent Events** together.

- **Live frontend:** `PASTE_NETLIFY_OR_VERCEL_URL`
- **Live backend:** `PASTE_RENDER_OR_RAILWAY_URL`

## What it does

A customer picks items from a catalog and places an order. A support agent updates the order status and chats 1-on-1 with the customer. Status changes appear on the customer's screen instantly, cancelling goes through JSON-RPC, and system alerts stream in over SSE.

## Protocols at a glance

| Requirement | Where | Used for |
|---|---|---|
| REST | `/api/v1/catalog`, `/api/v1/orders` | Catalog and order resources |
| WebSockets | Socket.io on the same server | Live status and 1-on-1 chat |
| JSON-RPC 2.0 | `POST /rpc` | `cancelOrder`, `getOrderStatus`, `ping` |
| SSE | `GET /events` | Live system alerts |

## REST API

| Method | Route | Description |
|---|---|---|
| GET | `/api/v1/catalog` | List products |
| GET | `/api/v1/orders` | List orders (`?status=` and `?customer=` filters) |
| GET | `/api/v1/orders/:id` | Get one order |
| POST | `/api/v1/orders` | Create order. Body: `{ "customerName": "Ali", "items": [{ "productId": 1, "qty": 2 }] }` |
| PATCH | `/api/v1/orders/:id/status` | Agent updates status. Body: `{ "status": "preparing" }` |

Statuses: `placed`, `confirmed`, `preparing`, `out_for_delivery`, `delivered`, `cancelled`.

## WebSocket events (Socket.io)

**Client to server**

| Event | Payload | Description |
|---|---|---|
| `order:subscribe` | `orderId` | Join `order:<id>` room to get live status updates |
| `agent:join` | none | Join the `agents` room to get order list change notifications |
| `chat:join` | `{ orderId, role, name }` | Join the chat room `chat:<orderId>`. `role` is `customer` or `agent`. Only one of each role per room (1-on-1) |
| `chat:message` | `{ text }` | Send a message (max 500 chars) |
| `chat:typing` | `true` / `false` | Typing indicator |
| `chat:leave` | none | Leave the chat |

**Server to client**

| Event | Payload | Description |
|---|---|---|
| `order:status` | `{ orderId, status, updatedAt }` | Order status changed |
| `orders:changed` | `{ orderId, status }` | Sent to agents when any order is created or changed |
| `chat:history` | `{ orderId, messages[] }` | Previous messages, sent on join |
| `chat:message` | `{ from, role, text, at }` | New chat message |
| `chat:system` | `{ message }` | Someone joined or left |
| `chat:typing` | `{ from, isTyping }` | Other person is typing |
| `chat:error` | `{ message }` | Invalid join, seat already taken, etc. |

## JSON-RPC 2.0 (`POST /rpc`)

Supports single calls, batch calls, notifications (no `id`, returns 204) and the standard error codes (-32700, -32600, -32601, -32602, -32603).

```json
{ "jsonrpc": "2.0", "method": "cancelOrder", "params": { "orderId": 1001 }, "id": 1 }
```

| Method | Params | Notes |
|---|---|---|
| `cancelOrder` | `orderId`, optional `reason` | Only allowed while status is `placed` or `confirmed`, otherwise error `-32005` |
| `getOrderStatus` | `orderId` | Error `-32004` if not found |
| `ping` | none | Returns `"pong"` |

## Server-Sent Events (`GET /events`)

Events: `connected` (on open) and `alert` (`{ level, message, time, orderId? }`). Alerts fire on new orders, status changes, cancellations, and a periodic system health message. Test it with:

```bash
curl -N https://YOUR-BACKEND-URL/events
```

## Run locally

```bash
cd backend
npm install
npm start          # http://localhost:3000
npm test           # end-to-end smoke test

# frontend: in another terminal
cd frontend
npx serve .        # or just open index.html
```

`frontend/config.js` holds `BACKEND_URL` (defaults to `http://localhost:3000`).

## Deployment

**Backend (Render)**
1. New Web Service, connect this repo, set **Root Directory** to `backend`.
2. Build command `npm install`, start command `npm start`.
3. Optional env var `CLIENT_ORIGIN` = your frontend URL (comma separated for several). Defaults to `*`.
4. Copy the Render URL.

**Frontend (Netlify or Vercel)**
1. Edit `frontend/config.js` and set `window.BACKEND_URL` to the Render URL.
2. Deploy the `frontend` folder (Netlify: drag and drop it, or set publish directory to `frontend`. Vercel: set Root Directory to `frontend`, framework preset "Other").

Note: on Render's free tier the server sleeps after inactivity, so the first request can take up to about a minute.

## Notes

Data is stored in memory, so orders and chats reset when the server restarts. That keeps setup simple for a lab, and a database can replace the `Map`s in `server.js` later.
