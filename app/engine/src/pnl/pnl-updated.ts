import { get_all_positions } from '../positions/positions-store'

export const pnl_store = new Map<number, number>()

export function update_pnl(market: string, mark_price: number): void {
  const positions = get_all_positions().filter(p => p.market === market)

  for (const position of positions) {
    const pnl = position.type === "LONG"
      ? (mark_price - position.averagePrice) * position.qty
      : (position.averagePrice - mark_price) * position.qty

    pnl_store.set(position.id, pnl)
  }
}
