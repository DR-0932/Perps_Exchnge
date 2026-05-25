// seed orderbook from DB on startup
import { orderbooks } from "./orderbook";
import { prisma } from "@perps/db"

export async function seed_orderbook():Promise<void>{
  const orders = await prisma.orders.findMany({
    where:{status:"OPEN",orderType:"LIMIT"}
  })

  for(const order of orders){
    const book = orderbooks.get(order.market)
    if(!book) continue

    const side = order.type ==="LONG" ? "BID" : "ASK"
    /**add_order take order object and side:"BID"|"ASK" as arguments */
    book.add_order({
      orderId:order.orderId,
      userId:order.userId,
      price:order.price,
      qty:order.qty,
      leverage:order.leverage,
      createdAt:order.createdAt.getTime()
    },side)
  }
  console.log(`Seeded ${orders.length} orders into orderbooks`)
  
}