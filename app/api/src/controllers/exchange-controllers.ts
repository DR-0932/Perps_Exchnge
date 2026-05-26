import type { Request, Response } from 'express'
import { onrampSchema, orderSchema } from '../types/exchange-schema'
import { prisma, redis } from '../db'

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
      where: { id: cltrlExists.id },
      data: { available: { increment: BigInt(amount) } }
    })
    res.status(200).json({ available: Number(updated.available), locked: Number(updated.locked) })
  } else {
    const created = await prisma.collateral.create({
      data: { available: BigInt(amount), locked: BigInt(0), userId }
    })
    res.status(201).json({ available: Number(created.available), locked: Number(created.locked) })
  }
}

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

  const margin_required = Math.round((price * qty) / leverage)
  const cltrl = await prisma.collateral.findFirst({ where: { userId } })

  if (!cltrl || cltrl.available < BigInt(margin_required)) {
    res.status(400).json({ error: "Insufficient collateral" })
    return
  }

  await prisma.collateral.update({
    where: { id: cltrl.id },
    data: {
      available: { decrement: BigInt(margin_required) },
      locked:    { increment: BigInt(margin_required) }
    }
  })

  const order = await prisma.order.create({
    data: { market, type, leverage, orderType, price: BigInt(price), qty: BigInt(qty),
      status: orderType === "MARKET" ? "FILLED" : "OPEN",
      userId
    }
  })

  if (orderType === "LIMIT") {
    await (redis as any).xadd("orders", "*",
      "action",    "NEW_ORDER",
      "market",    market,
      "orderId",   String(order.id),
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
    const raw_mark = await (redis as any).hget("mark_prices", market)
    if (!raw_mark) {
      res.status(400).json({ error: "Market price unavailable" })
      return
    }
    const fill_price = Number(raw_mark)

    const liquidationPrice = type === "LONG"
      ? fill_price * (1 - 1 / leverage)
      : fill_price * (1 + 1 / leverage)

    const position = await prisma.position.create({
      data: { market, type, qty: BigInt(qty), leverage, margin: BigInt(margin_required),
        averagePrice: BigInt(fill_price),
        liquidationPrice: BigInt(Math.round(liquidationPrice)),
        pnl: BigInt(0), userId
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

export async function cancelOrder(req: Request, res: Response): Promise<void> {
  const userId = req.userId

  const order = await prisma.order.findFirst({
    where: { id: Number(req.params.orderId), userId }
  })

  if (!order) {
    res.status(404).json({ error: "Order not found" })
    return
  }

  if (order.status !== "OPEN") {
    res.status(400).json({ error: "Only OPEN orders can be cancelled" })
    return
  }

  const cancelled = await prisma.order.update({
    where: { id: order.id },
    data: { status: "CANCELLED" }
  })

  const margin_to_unlock = Math.round((Number(order.price) * Number(order.qty)) / order.leverage)
  await prisma.collateral.updateMany({
    where: { userId },
    data: {
      available: { increment: BigInt(margin_to_unlock) },
      locked:    { decrement: BigInt(margin_to_unlock) }
    }
  })

  const key = order.type === "LONG" ? `${order.market}:bids` : `${order.market}:asks`
  await redis.zrem(key, String(order.id))

  await (redis as any).xadd(
    "orders", "*",
    "action",  "CANCEL_ORDER",
    "market",  order.market,
    "orderId", String(order.id),
    "type",    order.type,
    "price",   String(order.price)
  )

  res.status(200).json({ order: cancelled })
}

export async function getCollateral(req: Request, res: Response): Promise<void> {
  const userId = req.userId

  const cltrl = await prisma.collateral.findFirst({ where: { userId } })
  if (!cltrl) {
    res.status(404).json({ error: "No collateral found" })
    return
  }

  res.status(200).json({
    available: Number(cltrl.available),
    locked:    Number(cltrl.locked),
    total:     Number(cltrl.available + cltrl.locked)
  })
}

async function getPositions(userId: number | undefined, marketId: string, status: "OPEN" | "CLOSED") {
  return await prisma.position.findMany({
    where: { userId, market: marketId, status }
  })
}

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

export async function closePosition(req: Request, res: Response): Promise<void> {
  const userId = req.userId
  const positionId = Number(req.params.positionId)

  const position = await prisma.position.findFirst({
    where: { id: positionId, userId }
  })

  if (!position) {
    res.status(404).json({ error: "Position not found" })
    return
  }
  if (position.status !== "OPEN") {
    res.status(400).json({ error: "Position is not open" })
    return
  }

  const raw_mark = await (redis as any).hget("mark_prices", position.market)
  const mark_price = raw_mark ? Number(raw_mark) : Number(position.averagePrice)

  const pnl = position.type === "LONG"
    ? (mark_price - Number(position.averagePrice)) * Number(position.qty) //bind the logic somewhere else
    : (Number(position.averagePrice) - mark_price) * Number(position.qty)

  const collateral_return = Math.max(0, Number(position.margin) + pnl)

  await prisma.$transaction([
    prisma.position.update({
      where: { id: positionId },
      data: { status: "CLOSED", pnl: BigInt(Math.round(pnl)) }
    }),
    prisma.collateral.updateMany({
      where: { userId },
      data: {
        available: { increment: BigInt(collateral_return) },
        locked:    { decrement: position.margin }
      }
    })
  ])

  await (redis as any).xadd(
    "positions", "*",
    "action",     "CLOSE",
    "positionId", String(positionId)
  )
  res.status(200).json({ message: "position closed", pnl })
}

async function getOrders(userId: number | undefined, marketId: string, status?: string) {
  return await prisma.order.findMany({
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

  const orders = await getOrders(userId, marketId, "CANCELLED")
  if (!orders.length) {
    res.status(404).json({ error: "No closed orders found" })
    return
  }
  res.status(200).json({ orders })
}

export async function getFills(req: Request, res: Response): Promise<void> {
  const userId = req.userId
  const fills = await prisma.fill.findMany({ where: { userId } })
  res.status(200).json({ fills })
}
