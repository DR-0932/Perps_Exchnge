import { orderbooks } from "./orderbook";
import { prisma } from "@perps/db"

export async function seed_orderbook(): Promise<void> {
  const orders = await prisma.order.findMany({
    where: { status: "OPEN", orderType: "LIMIT" }
  })

  for (const order of orders) {
    const book = orderbooks.get(order.market)
    if (!book) continue

    const side = order.type === "LONG" ? "BID" : "ASK"
    book.add_order({
      orderId:   order.id,
      userId:    order.userId,
      price:     Number(order.price),
      qty:       Number(order.qty),
      leverage:  order.leverage,
      createdAt: order.createdAt.getTime()
    }, side)
  }
  console.log(`Seeded ${orders.length} orders into orderbooks`)
}
