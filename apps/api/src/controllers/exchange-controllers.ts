import type { Request, Response } from 'express'
import { onrampSchema, orderSchema } from '../types/exchange-schema'
import { prisma, redis } from '../db'

/**user deposits money,find cltrl record in DB and update avl or create new */
export async function onRamp(req: Request, res: Response): Promise<void> {
  const userId = req.userId
  const parsedBody = onrampSchema.safeParse(req.body)

  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error })
    return
  }

  const { amount } = parsedBody.data
  const cltrlExists = await prisma.collateral.findFirst({ where: { userId } })

  if (cltrlExists) {
    const updated = await prisma.collateral.update({
      where: { collateralId: cltrlExists.collateralId },
      data: { available: { increment: amount } }
    })
    res.status(200).json({ available: updated.available, locked: updated.locked })
  } else {
    const created = await prisma.collateral.create({
      data: { available: amount, locked: 0, userId }
    })
    res.status(201).json({ available: created.available, locked: created.locked })
  }
}

/** creating orders/margin_required check,update margin to avl/locked,limit orders pushed to redis */
const MAX_LEVERAGE = 100
export async function Order(req: Request, res: Response): Promise<void> {
  const parsedBody = orderSchema.safeParse(req.body)
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error })
    return
  }

  const userId = req.userId
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" })
    return
  }

  const { type, market, orderType, price, leverage, qty } = parsedBody.data

  if (leverage > MAX_LEVERAGE) {
    res.status(400).json({ error: `Max leverage is ${MAX_LEVERAGE}x` })
    return
  }

  // margin_required = collateral the user must have to back this position
  const margin_required = Math.round((price * qty) / leverage)
  const cltrl = await prisma.collateral.findFirst({ where: { userId } })

  if (!cltrl || cltrl.available < margin_required) {
    res.status(400).json({ error: "Insufficient collateral" })
    return
  }

  await prisma.collateral.update({
    where: { collateralId: cltrl.collateralId },
    data: {
      available: { decrement: margin_required },
      locked:    { increment: margin_required }
    }
  })

  const order = await prisma.orders.create({
    data: { market, type, leverage, orderType, price, qty,
      status: orderType === "MARKET" ? "FILLED" : "OPEN",
      userId
    }
  })

  if (orderType === "LIMIT") {
    await redis.xadd("orders", "*",
      "action",    "NEW_ORDER",
      "market",    market,
      "orderId",   String(order.orderId),
      "userId",    String(userId),
      "type",      type,
      "orderType", orderType,
      "price",     String(price),
      "qty",       String(qty),
      "leverage",  String(leverage),
      "createdAt", String(order.createdAt.getTime())
    )
  }

  if (orderType === "MARKET") {
    const liquidationPrice = type === "LONG"
      ? price * (1 - 1 / leverage)
      : price * (1 + 1 / leverage)

    const position = await prisma.position.create({
      data: { market, type, qty, leverage, margin: margin_required, averagePrice: price,
        liquidationPrice: Math.round(liquidationPrice),
        pnl: 0, userId
      }
    })

    await (redis as any).xadd(
      "positions", "*",
      "action",           "OPEN",
      "positionId",       String(position.id),
      "userId",           String(position.userId),
      "market",           position.market,
      "type",             position.type,
      "liquidationPrice", String(position.liquidationPrice),
      "margin",           String(position.margin),
      "averagePrice",     String(position.averagePrice),
      "qty",              String(position.qty)
    )
  }

  res.status(201).json({ order })
}

/**set status to cancelled,unlock margin,remove from redis sorted set */
export async function cancelOrder(req: Request, res: Response): Promise<void> {
  const userId = req.userId

  const order = await prisma.orders.findFirst({
    where: { orderId: Number(req.params.orderId), userId }
  })

  if (!order) {
    res.status(404).json({ error: "Order not found" })
    return
  }

  if (order.status !== "OPEN") {
    res.status(400).json({ error: "Only OPEN orders can be cancelled" })
    return
  }

  const cancelled = await prisma.orders.update({
    where: { orderId: order.orderId },
    data: { status: "CANCELLED" }
  })

  // derive margin to unlock from qty stored on the order
  const margin_to_unlock = Math.round((order.price * order.qty) / order.leverage)
  await prisma.collateral.updateMany({
    where: { userId },
    data: {
      available: { increment: margin_to_unlock },
      locked:    { decrement: margin_to_unlock }
    }
  })

  // remove from Redis sorted set so orderbook snapshot stays clean
  const key = order.type === "LONG" ? `${order.market}:bids` : `${order.market}:asks`
  await redis.zrem(key, String(order.orderId))

  // notify engine to remove from in-memory orderbook
  await (redis as any).xadd(
    "orders", "*",
    "action",  "CANCEL_ORDER",
    "market",  order.market,
    "orderId", String(order.orderId),
    "type",    order.type,
    "price",   String(order.price)
  )

  res.status(200).json({ order: cancelled })
}

/**return avl,lckd,total,cltrl table readonly */
export async function equityAvl(req: Request, res: Response): Promise<void> {
  const userId = req.userId

  const cltrl = await prisma.collateral.findFirst({ where: { userId } })
  if (!cltrl) {
    res.status(404).json({ error: "No collateral found" })
    return
  }

  res.status(200).json({
    available: cltrl.available,
    locked: cltrl.locked,
    total: cltrl.available + cltrl.locked
  })
}

// positions helper
async function getPositions(userId: number | undefined, marketId: string, status: "OPEN" | "CLOSED") {
  return await prisma.position.findMany({
    where: { userId, market: marketId, status }
  })
}

/** Need to review once more */
export async function openPosition(req: Request, res: Response): Promise<void> {
  const userId = req.userId
  const marketId = req.params.marketId as string

  const positions = await getPositions(userId, marketId, "OPEN")

  if (!positions.length) {
    res.status(404).json({ error: "No open positions found" })
    return
  }

  res.status(200).json({ positions })
}


export async function closedPosition(req: Request, res: Response): Promise<void> {
  const userId = req.userId
  const marketId = req.params.marketId as string

  const positions = await getPositions(userId, marketId, "CLOSED")

  if (!positions.length) {
    res.status(404).json({ error: "No closed positions found" })
    return
  }

  res.status(200).json({ positions })
}

export async function closePosition(req:Request,res:Response):Promise<void>{
  const userId =req.userId;
  const positionId= Number(req.params.positionId)

  const position = await prisma.position.findFirst({
    where:{id:positionId,userId}
  })

  if(!position){
    res.status(404).json({error:"position not found"})
    return
  }
  if(position.status !== "OPEN"){
    res.status(400).json({error:"postion is not open"})
    return
  }

  const raw_mark = await (redis as any).hget("mark_prices", position.market)
  const mark_price = raw_mark ? Number(raw_mark) : position.averagePrice
  const pnl = position.type === "LONG"
    ? (mark_price - position.averagePrice) * position.qty
    : (position.averagePrice - mark_price) * position.qty
  const collateral_return = Math.max(0, position.margin + pnl)

  await prisma.$transaction([
    prisma.position.update({
      where:{id:positionId},
      data:{status:"CLOSED", pnl}
    }),
    prisma.collateral.updateMany({
      where:{userId},
      data:{
        available:{increment:collateral_return},
        locked:{decrement:position.margin}
      }
    })
  ])

  await (redis as any).xadd(
    "positions","*",
    "action","CLOSE",
    "positionId",String(positionId)
  )
  res.status(200).json({message:"position closed", pnl})
}


// orders helper
async function getOrders(userId: number | undefined, marketId: string, status?: string) {
  return await prisma.orders.findMany({
    where: { userId, market: marketId, ...(status && { status }) }
  })
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const userId = req.userId
  const marketId = req.params.marketId as string

  const orders = await getOrders(userId, marketId)

  if (!orders.length) {
    res.status(404).json({ error: "No orders found" })
    return
  }

  res.status(200).json({ orders })
}

export async function openOrder(req: Request, res: Response): Promise<void> {
  const userId = req.userId
  const marketId = req.params.marketId as string

  const orders = await getOrders(userId, marketId, "OPEN")

  if (!orders.length) {
    res.status(404).json({ error: "No open orders found" })
    return
  }

  res.status(200).json({ orders })
}

export async function closedOrder(req: Request, res: Response): Promise<void> {
  const userId = req.userId
  const marketId = req.params.marketId as string

  const orders = await getOrders(userId, marketId, "CLOSED")

  if (!orders.length) {
    res.status(404).json({ error: "No closed orders found" })
    return
  }

  res.status(200).json({ orders })
}

// fills
export async function getFills(req: Request, res: Response): Promise<void> {
  const userId = req.userId

  const fills = await prisma.fills.findMany({ where: { userId } })

  res.status(200).json({ fills })
}
