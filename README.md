# perps-v1

A perpetuals (perps) trading exchange backend built from scratch. Supports leveraged LONG/SHORT positions on BTC-USDT, ETH-USDT, and SOL-USDT with limit and market orders, real-time mark price from Binance, and an event-driven liquidation engine.

---

## Architecture

```
┌─────────────┐        Redis Stream         ┌──────────────────────────────────────────┐
│             │  ──── "orders" ──────────►  │                ENGINE                    │
│     API     │                             │                                          │
│  (Express)  │  ◄─── "fills" ───────────  │  ┌─────────────┐   ┌──────────────────┐ │
│             │                             │  │  Orderbook  │   │ Matching Engine  │ │
│             │  ◄─── "liquidations" ─────  │  │  (B-Tree)   │──►│  (price-time     │ │
│             │                             │  └─────────────┘   │   priority)      │ │
│             │  ──── "positions" ───────►  │                    └──────────────────┘ │
└──────┬──────┘                             │                                          │
       │                                    │  ┌─────────────┐   ┌──────────────────┐ │
       │                                    │  │  Positions  │   │   Liquidation    │ │
  PostgreSQL                                │  │   Store     │──►│     Engine       │ │
  (Prisma)                                  │  │ (in-memory) │   │  (every 5s)      │ │
                                            │  └─────────────┘   └──────────────────┘ │
                                            │                                          │
                                            │  ┌──────────────────────────────────┐   │
                                            │  │         Mark Price Feed          │   │
                                            │  │  Binance WSS ──► mark_prices Map │   │
                                            │  └──────────────────────────────────┘   │
                                            └──────────────────────────────────────────┘
```

---

## Planned Architecture (WIP)

```
Binance Futures WSS
        │
        ▼
  mark_prices Map
        │
        ├──────────────────────────────────────────────────────┐
        ▼                                                       ▼
  Redis PubSub                                          Liquidation Engine
  (orderbook, trades,                                   (breach check on
   mark_price channels)                                  every price tick)
        │
        ▼
   WS Server (apps/ws)
        │
        ▼
  Frontend clients
```

Redis PubSub channels (planned):

| Channel | Published by | Data |
|---|---|---|
| `orderbook:BTC-USDT` | Engine | Best bids/asks after each match |
| `trades:BTC-USDT` | Engine | Fill price + qty on each match |
| `mark_price:BTC-USDT` | Mark price feed | Latest mark price every 1s |

---

## Services

### `apps/api` — REST API (port 3000)
HTTP server built with Express. Handles all client requests, writes to PostgreSQL, and communicates with the engine via Redis Streams.

**Routes:**
```
POST   /auth/signup
POST   /auth/signIn

POST   /exchange/onramp                   deposit collateral
POST   /exchange/order                    place LONG/SHORT, LIMIT/MARKET order
DELETE /exchange/order/:orderId           cancel a limit order

GET    /exchange/equity/available         collateral balance
GET    /exchange/positions/open/:marketId
GET    /exchange/positions/closed/:marketId
GET    /exchange/orders/open/:marketId
GET    /exchange/orders/closed/:marketId
GET    /exchange/orders/:marketId
GET    /exchange/fills
```

**Redis stream consumers:**
- `"fills"` — creates Fill + Position rows in DB, publishes to `"positions"` stream
- `"liquidations"` — closes position in DB, releases collateral, publishes `CLOSE` to `"positions"` stream

### `apps/engine` — Matching Engine
Pure computation service. No HTTP server, no DB writes. Consumes orders from Redis, matches them in-memory, publishes results back via Redis.

**Components:**
- **Orderbook** (`src/orderbook/`) — B-tree per market. Price levels are `Map<orderId, Order>`. Seeded from DB on startup.
- **Matching Engine** (`src/matching/`) — price-time priority. The passive order (placed first) gets its price.
- **Mark Price Feed** (`src/mark-price/`) — WebSocket to Binance Futures. Prices stored as integers × 100 to avoid float precision issues.
- **Positions Store** (`src/positions/`) — in-memory Map of open positions, synced via `"positions"` Redis stream.
- **Liquidation Engine** (`src/liquidation/`) — polls positions store every 5s, compares against mark price, publishes breached positions to `"liquidations"` stream.

**Redis stream consumers:**
- `"orders"` — processes `NEW_ORDER` and `CANCEL_ORDER`, runs matching after each new limit order
- `"positions"` — keeps in-memory positions store in sync (`OPEN` / `CLOSE` actions)

---

## Data Flow

### Placing a limit order
```
Client POST /exchange/order
  → API validates, locks margin in Collateral, creates Orders row (status: OPEN)
  → API publishes to "orders" stream
  → Engine receives, adds to B-tree orderbook
  → Engine runs match_orders()
  → If match found: publishes to "fills" stream
  → API receives fill, creates Fill rows + Position rows in DB
  → API publishes to "positions" stream
  → Engine receives, adds position to in-memory store
```

### Liquidation
```
Binance WSS sends mark price every 1s
  → Engine stores in mark_prices Map (as integer × 100)
  → Liquidation engine checks all positions in store every 5s
  → If mark_price breaches liquidationPrice: publishes to "liquidations" stream
  → API receives, closes position in DB, decrements locked collateral
  → API publishes CLOSE to "positions" stream
  → Engine removes position from in-memory store
```

### Price format
All prices are stored and transmitted as **integers × 100** (cents).
- `$67,432.51` → stored as `6743251`
- Prevents JavaScript float precision errors throughout the system
- Frontend divides by 100 to display

### Liquidation price formula
```
LONG:  liquidationPrice = entryPrice × (1 - 1/leverage)
SHORT: liquidationPrice = entryPrice × (1 + 1/leverage)
```
At 10× leverage: liquidated on a 10% adverse move — the point where margin is fully exhausted.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| API framework | Express |
| Database | PostgreSQL via Prisma |
| Message queue | Redis Streams (XADD / XREADGROUP / XACK) |
| Real-time prices | Binance Futures WebSocket (`fstream.binance.com`) |
| Orderbook | `sorted-btree` (B-tree) |
| Auth | JWT + bcrypt (`Bun.password`) |
| Validation | Zod |
| Monorepo | Bun workspaces |

---

## Project Structure

```
perps_exchange/
├── apps/
│   ├── api/                    REST API
│   │   ├── index.ts            entry — Express server + stream consumers
│   │   └── src/
│   │       ├── controllers/    route handlers
│   │       ├── middlewares/    JWT auth
│   │       ├── routes/         Express routers
│   │       └── types/          Zod schemas
│   ├── engine/                 Matching engine
│   │   ├── index.ts            entry — stream consumers + startup
│   │   └── src/
│   │       ├── orderbook/      B-tree orderbook + seed
│   │       ├── matching/       matching engine
│   │       ├── mark-price/     Binance WebSocket price feed
│   │       ├── positions/      in-memory positions store
│   │       ├── liquidation/    liquidation engine
│   │       └── funding/        funding rate (WIP)
│   └── tests/                  integration tests (WIP)
├── packages/
│   └── db/                     shared Prisma client + Redis
└── prisma/
    └── schema.prisma
```

---

## Getting Started

### Prerequisites
- Bun
- PostgreSQL
- Redis

### Install
```bash
bun install
```

### Environment variables
```env
DATABASE_URL=postgresql://user:password@localhost:5432/perps
REDIS_URL=redis://localhost:6379
JWT_SECRET=your_secret
```

### Database setup
```bash
bunx prisma migrate dev
bunx prisma generate
```

### Run
```bash
# API
bun run apps/api/index.ts

# Engine (separate terminal)
bun run apps/engine/index.ts
```

---

## What's implemented

- [x] Auth (signup / signin)
- [x] Collateral (onramp, margin locking)
- [x] Limit orders — full lifecycle (place, match, fill, cancel)
- [x] Market orders — position creation
- [x] Matching engine — price-time priority B-tree orderbook
- [x] Fill processing — DB persistence via Redis stream
- [x] Mark price feed — Binance Futures WebSocket, prices as int × 100
- [x] Liquidation engine — Redis stream based, no DB writes in engine
- [x] In-memory positions store — synced via Redis stream

## What's in progress

- [ ] Close position endpoint
- [ ] PnL updates
- [ ] Market orders through matching engine
- [ ] Funding rate
- [ ] WebSocket server for frontend
- [ ] Redis PubSub (orderbook, trades, mark price broadcast)
- [ ] Integration tests
