import { redis } from "../db"
import { mark_prices } from "../mark-price/markprice"
import { get_all_positions } from "../positions/positions-store"

const pending_liquidations = new Set<number>()

async function check_liquidations(): Promise<void> {
  const positions = get_all_positions()

  for (const position of positions) {
    if (pending_liquidations.has(position.id)) continue

    const mark_price = mark_prices.get(position.market)
    if (!mark_price) continue

    const should_liquidate = position.type === "LONG"
      ? mark_price <= position.liquidationPrice
      : mark_price >= position.liquidationPrice

    if (should_liquidate) {
      pending_liquidations.add(position.id)
      await (redis as any).xadd(
        "liquidations", "*",
        "positionId", String(position.id),
        "userId",     String(position.userId),
        "margin",     String(position.margin),
        "market",     position.market
      )
      console.log(`Liquidation triggered — position ${position.id} user ${position.userId}`)
    }
  }
}

export function start_liquidation_engine(interval_ms = 5000): void {
  setInterval(check_liquidations, interval_ms)
  console.log(`Liquidation engine running — checking every ${interval_ms}ms`)
}
