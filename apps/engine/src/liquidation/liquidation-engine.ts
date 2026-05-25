import { redis } from "../db"
import { get_all_positions } from "../positions/positions-store"

const pending_liquidations = new Set<number>()

export async function check_liquidations(market: string, mark_price: number): Promise<void> {
  const positions = get_all_positions().filter(p => p.market === market)

  for (const position of positions) {
    if (pending_liquidations.has(position.id)) continue

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
