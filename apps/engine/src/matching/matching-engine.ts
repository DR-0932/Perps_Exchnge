import { redis } from '../db'
import { orderbooks, Orderbook } from '../orderbook/orderbook'
import type { Order } from '../orderbook/orderbook'

interface FillResult {
  fill_price:        number
  fill_qty:          number
  bid_fully_filled:  boolean
  ask_fully_filled:  boolean
  remaining_bid_qty: number
  remaining_ask_qty: number
  filled_bid_margin: number
  filled_ask_margin: number
}

function calculateFill(best_bid: Order, best_ask: Order): FillResult {
  const fill_price = best_bid.createdAt < best_ask.createdAt
    ? best_bid.price
    : best_ask.price

  const fill_qty = Math.min(best_bid.qty, best_ask.qty)

  const bid_fully_filled = best_bid.qty <= best_ask.qty
  const ask_fully_filled = best_ask.qty <= best_bid.qty

  const remaining_bid_qty = best_bid.qty - fill_qty
  const remaining_ask_qty = best_ask.qty - fill_qty

  // margin used for position creation on the backend
  const filled_bid_margin = Math.round((fill_qty * fill_price) / best_bid.leverage)
  const filled_ask_margin = Math.round((fill_qty * fill_price) / best_ask.leverage)

  return {
    fill_price, fill_qty,
    bid_fully_filled, ask_fully_filled,
    remaining_bid_qty, remaining_ask_qty,
    filled_bid_margin, filled_ask_margin
  }
}

function updateOrderbook(book: Orderbook, best_bid: Order, best_ask: Order, fill: FillResult): void {
  if (fill.bid_fully_filled) {
    book.remove_order(best_bid.orderId, "BID", best_bid.price)
  } else {
    book.update_order_qty(best_bid.orderId, best_bid.price, "BID", fill.remaining_bid_qty)
  }

  if (fill.ask_fully_filled) {
    book.remove_order(best_ask.orderId, "ASK", best_ask.price)
  } else {
    book.update_order_qty(best_ask.orderId, best_ask.price, "ASK", fill.remaining_ask_qty)
  }
}

export async function match_orders(market: string): Promise<void> {
  const book = orderbooks.get(market)
  if (!book) return

  while (true) {
    const best_bid = book.best_bid()
    const best_ask = book.best_ask()

    if (!best_bid || !best_ask) break
    if (best_bid.price < best_ask.price) break

    const fill = calculateFill(best_bid, best_ask)
    updateOrderbook(book, best_bid, best_ask, fill)

    // publish fill to backend via fills stream — backend handles DB + WS
    await (redis as any).xadd(
      "fills", "*",
      "market",            market,
      "fill_price",        String(fill.fill_price),
      "fill_qty",          String(fill.fill_qty),
      "bid_orderId",       String(best_bid.orderId),
      "ask_orderId",       String(best_ask.orderId),
      "bid_userId",        String(best_bid.userId),
      "ask_userId",        String(best_ask.userId),
      "remaining_bid_qty", String(fill.remaining_bid_qty),
      "remaining_ask_qty", String(fill.remaining_ask_qty),
      "filled_bid_margin", String(fill.filled_bid_margin),
      "filled_ask_margin", String(fill.filled_ask_margin),
      "bid_fully_filled",  String(fill.bid_fully_filled),
      "ask_fully_filled",  String(fill.ask_fully_filled),
      "bid_leverage",      String(best_bid.leverage),
      "ask_leverage",      String(best_ask.leverage),
      "timestamp",         String(Date.now())
    )
  }
}
/** 1. order comes in long or short ,
 * 2. order goes through immediate matching just in case, the order could be matched and position is created 
 * 3. the order could sit in the orderbook where it is continously checked when new ordrd comein or price of current orderbook changes
 * to match against something
 * 4. if they match both are removed from the orderboook , the ack is sent thorugh the rediss steam to the backend, the backend send to
 * db for persistence,
 * 
 */