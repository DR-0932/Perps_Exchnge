import { redis } from './src/db'
import { seed_orderbook } from './src/orderbook/seed'
import { match_orders } from './src/matching/matching-engine'
import { orderbooks } from './src/orderbook/orderbook'
import { connect_mark_price_feed } from './src/mark-price/markprice'
import { start_liquidation_engine } from './src/liquidation/liquidation-engine'
import { add_position, remove_position } from './src/positions/positions-store'

const ORDERS_STREAM    = "orders"
const ORDERS_GROUP     = "engine"
const ORDERS_CONSUMER  = "consumer-1"

const POSITIONS_STREAM   = "positions"
const POSITIONS_GROUP    = "engine-positions"
const POSITIONS_CONSUMER = "consumer-1"

function parseFields(arr: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < arr.length; i += 2) {
    out[arr[i]!] = arr[i + 1]!
  }
  return out
}

async function ensureConsumerGroup(stream: string, group: string) {
  try {
    await (redis as any).call("XGROUP", "CREATE", stream, group, "$", "MKSTREAM")
  } catch (e: any) {
    if (!String(e?.message).includes("BUSYGROUP")) throw e
  }
}

async function processOrderMessage(id: string, fields: Record<string, string>) {
  const { action, market, orderId, userId, type, orderType, price, qty, leverage, createdAt } = fields

  if (!market || !action) {
    console.error(`Malformed stream message — missing required fields, id: ${id}`)
    await (redis as any).call("XACK", ORDERS_STREAM, ORDERS_GROUP, id)
    return
  }

  if (action === "CANCEL_ORDER") {
    const side = type === "LONG" ? "BID" : "ASK"
    orderbooks.get(market)?.remove_order(Number(orderId), side, Number(price))

  } else if (action === "NEW_ORDER" && orderType === "LIMIT") {
    const side = type === "LONG" ? "BID" : "ASK"
    const book = orderbooks.get(market)
    if (book) {
      book.add_order({
        orderId:   Number(orderId),
        userId:    Number(userId),
        price:     Number(price),
        qty:       Number(qty),
        leverage:  Number(leverage),
        createdAt: Number(createdAt)
      }, side)
      await match_orders(market)
    }
  }

  await (redis as any).call("XACK", ORDERS_STREAM, ORDERS_GROUP, id)
}

function processPositionMessage(fields: Record<string, string>) {
  const { action, positionId, userId, market, type, liquidationPrice, margin } = fields

  if (action === "OPEN") {
    add_position({
      id:               Number(positionId),
      userId:           Number(userId),
      market:           market!,
      type:             type!,
      liquidationPrice: Number(liquidationPrice),
      margin:           Number(margin)
    })
  } else if (action === "CLOSE") {
    remove_position(Number(positionId))
  }
}

async function consume_orders_stream() {
  while (true) {
    const result = await (redis as any).call(
      "XREADGROUP", "GROUP", ORDERS_GROUP, ORDERS_CONSUMER,
      "COUNT", "10", "BLOCK", "0",
      "STREAMS", ORDERS_STREAM, ">"
    ) as [[string, [string, string[]][]]] | null

    if (!result) continue

    const [[, messages]] = result
    for (const [id, fieldArray] of messages) {
      await processOrderMessage(id, parseFields(fieldArray))
    }
  }
}

async function consume_positions_stream() {
  while (true) {
    const result = await (redis as any).call(
      "XREADGROUP", "GROUP", POSITIONS_GROUP, POSITIONS_CONSUMER,
      "COUNT", "10", "BLOCK", "0",
      "STREAMS", POSITIONS_STREAM, ">"
    ) as [[string, [string, string[]][]]] | null

    if (!result) continue

    const [[, messages]] = result
    for (const [id, fieldArray] of messages) {
      processPositionMessage(parseFields(fieldArray))
      await (redis as any).call("XACK", POSITIONS_STREAM, POSITIONS_GROUP, id)
    }
  }
}

async function start() {
  await seed_orderbook()
  await ensureConsumerGroup(ORDERS_STREAM, ORDERS_GROUP)
  await ensureConsumerGroup(POSITIONS_STREAM, POSITIONS_GROUP)
  connect_mark_price_feed()
  start_liquidation_engine()

  console.log(`Engine ready`)

  await Promise.all([
    consume_orders_stream(),
    consume_positions_stream()
  ])
}

start().catch(console.error)
