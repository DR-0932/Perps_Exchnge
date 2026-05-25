import { prisma } from "../db"

export async function matchOrders(market: string): Promise<void> {

  const long_orders = await prisma.orders.findMany({
    where: { market, status: "OPEN", type: "LONG", orderType: "LIMIT" },
    orderBy: { price: "desc" }
  })

  const short_orders = await prisma.orders.findMany({
    where: { market, status: "OPEN", type: "SHORT", orderType: "LIMIT" },
    orderBy: { price: "asc" }
  })

  if (long_orders.length === 0 || short_orders.length === 0) return

  const best_bid = long_orders[0]
  const best_ask = short_orders[0]

  if (!best_bid || !best_ask) return
  if (best_bid.price < best_ask.price) return

  const fill_price = best_bid.createdAt < best_ask.createdAt
    ? best_bid.price
    : best_ask.price

  /*---- value of asset controlled by a trade ----*/
  const bid_notional = best_bid.margin * best_bid.leverage
  const ask_notional = best_ask.margin * best_ask.leverage
  const fill_notional = Math.min(bid_notional, ask_notional)

  const fill_qty = Math.round(fill_notional / fill_price)

  /*---- orders that are completely filled ----*/
  const bid_fully_filled = bid_notional <= ask_notional
  const ask_fully_filled = ask_notional <= bid_notional

  /*---- margin for partially filled orders ----*/
  const remaining_bid_margin = Math.round(best_bid.margin - (fill_notional / best_bid.leverage))
  const remaining_ask_margin = Math.round(best_ask.margin - (fill_notional / best_ask.leverage))

  /*---- margin of the portion that was actually filled ----*/
  const filled_bid_margin = Math.round(fill_notional / best_bid.leverage)
  const filled_ask_margin = Math.round(fill_notional / best_ask.leverage)

  await prisma.$transaction([
    // update LONG order
    prisma.orders.update({
      where: { orderId: best_bid.orderId },
      data: bid_fully_filled
        ? { status: "FILLED" }
        : { margin: remaining_bid_margin }
    }),

    // update SHORT order
    prisma.orders.update({
      where: { orderId: best_ask.orderId },
      data: ask_fully_filled
        ? { status: "FILLED" }
        : { margin: remaining_ask_margin }
    }),

    // fill for LONG user
    prisma.fills.create({
      data: { price: fill_price, qty: fill_qty, market, orderId: best_bid.orderId, userId: best_bid.userId }
    }),

    // fill for SHORT user
    prisma.fills.create({
      data: { price: fill_price, qty: fill_qty, market, orderId: best_ask.orderId, userId: best_ask.userId }
    }),

    // LONG position
    prisma.position.create({
      data: {
        market, type: "LONG",
        margin: filled_bid_margin,
        averagePrice: fill_price,
        liquidationPrice: Math.round(fill_price * (1 - 1 / best_bid.leverage)),
        pnl: 0, userId: best_bid.userId
      }
    }),

    // SHORT position
    prisma.position.create({
      data: {
        market, type: "SHORT",
        margin: filled_ask_margin,
        averagePrice: fill_price,
        liquidationPrice: Math.round(fill_price * (1 + 1 / best_ask.leverage)),
        pnl: 0, userId: best_ask.userId
      }
    })
  ])

  await matchOrders(market)
}

export function startMatchingEngine(): void {
  const markets = ["BTC-USDT", "ETH-USDT", "SOL-USDT"]

  setInterval(async () => {
    for (const market of markets) {
      await matchOrders(market)
    }
  }, 1000)
}
