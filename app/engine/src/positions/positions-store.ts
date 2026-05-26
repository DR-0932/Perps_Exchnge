export interface PositionEntry {
  id:               number
  userId:           number
  market:           string
  type:             string
  liquidationPrice: number
  margin:           number
  averagePrice:     number
  qty:              number
}

export const positions_store = new Map<number, PositionEntry>()

export function add_position(p: PositionEntry): void {
  positions_store.set(p.id, p)
}

export function remove_position(positionId: number): void {
  positions_store.delete(positionId)
}

export function get_all_positions(): PositionEntry[] {
  return [...positions_store.values()]
}
  