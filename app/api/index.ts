import express from "express";
import { authrouter } from "./src/routes/auth-routes";
import { exchangeRouter } from "./src/routes/exchange-routes";
import { prisma,redis } from "./src/db";

const app = express();
const FILLS_STREAM ="fills"
const FILLS_GROUP = "api-group"
const FILLS_CONSUMER = "consumer-1"

app.use(express.json());
app.set('json replacer', (_: string, v: any) => typeof v === 'bigint' ? Number(v) : v)

app.use("/auth", authrouter);
app.use("/exchange", exchangeRouter);

function parseFields(arr: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < arr.length; i += 2) {
    out[arr[i]!] = arr[i + 1]!
  }
  return out
}


interface FillFields{
  market:     string,
  fill_price: number
  fill_qty:   number
  bid_orderId: number
  ask_orderId: number
  bid_userId: number
  ask_userId: number
  filled_bid_margin:  number
  filled_ask_margin: number
  bid_fully_filled: boolean
  ask_fully_filled: boolean
  bid_leverage: number
  ask_leverage: number
}


function parse_filled_fields(raw: Record<string,string>):FillFields{
  return{
    market:   raw.market!,
    fill_price: Number(raw.fill_price),
    fill_qty: Number(raw.fill_qty),
    bid_orderId: Number(raw.bid_orderId),
    ask_orderId: Number(raw.ask_orderId),
    bid_userId: Number(raw.bid_userId),
    ask_userId: Number(raw.ask_userId),
    filled_bid_margin:Number(raw.filled_bid_margin),
    filled_ask_margin:Number(raw.filled_ask_margin),
    bid_fully_filled: raw.bid_fully_filled === "true",
    ask_fully_filled: raw.ask_fully_filled === "true",
    bid_leverage: Number(raw.bid_leverage),
    ask_leverage: Number(raw.ask_leverage)
  }
}

async function processFill(raw:Record<string,string>):Promise<void>{
  const f  = parse_filled_fields(raw)

  const bid_liq_price = Math.round(f.fill_price * (1 - 1 / f.bid_leverage))
  const ask_liq_price = Math.round(f.fill_price * (1 + 1 / f.ask_leverage))

  const [,,bidPosition, askPosition] = await prisma.$transaction([
    prisma.fill.create({
      data:{
        price:        BigInt(f.fill_price),
        qty:          BigInt(f.fill_qty),
        market:       f.market,
        marketId:     f.market,
        makerOrderId: f.bid_orderId,
        takerOrderId: f.ask_orderId,
        userId:       f.bid_userId
      }
    }),
    prisma.fill.create({
      data:{
        price:        BigInt(f.fill_price),
        qty:          BigInt(f.fill_qty),
        market:       f.market,
        marketId:     f.market,
        makerOrderId: f.bid_orderId,
        takerOrderId: f.ask_orderId,
        userId:       f.ask_userId
      }
    }),
    prisma.position.create({
      data:{
        market:           f.market,
        type:             "LONG",
        qty:              BigInt(f.fill_qty),
        leverage:         f.bid_leverage,
        margin:           BigInt(f.filled_bid_margin),
        averagePrice:     BigInt(f.fill_price),
        liquidationPrice: BigInt(bid_liq_price),
        pnl:              BigInt(0),
        userId:           f.bid_userId
      }
    }),
    prisma.position.create({
      data:{
        market:           f.market,
        type:             "SHORT",
        qty:              BigInt(f.fill_qty),
        leverage:         f.ask_leverage,
        margin:           BigInt(f.filled_ask_margin),
        averagePrice:     BigInt(f.fill_price),
        liquidationPrice: BigInt(ask_liq_price),
        pnl:              BigInt(0),
        userId:           f.ask_userId
      }
    }),
    ...(f.bid_fully_filled ? [prisma.order.update({
      where:{ id: f.bid_orderId },
      data: { status: "FILLED" },
    })]:[]),

    ...(f.ask_fully_filled ? [prisma.order.update({
      where:{ id: f.ask_orderId },
      data: { status: "FILLED" },
    })]:[]),
  ])

  await Promise.all([
    (redis as any).xadd(
      "positions", "*",
      "action",           "OPEN",
      "positionId",       String(bidPosition.id),
      "userId",           String(bidPosition.userId),
      "market",           bidPosition.market,
      "type",             bidPosition.type,
      "liquidationPrice", String(bidPosition.liquidationPrice),
      "margin",           String(bidPosition.margin),
      "averagePrice",     String(bidPosition.averagePrice),
      "qty",              String(bidPosition.qty)
    ),

    (redis as any).xadd(
      "positions", "*",
      "action",           "OPEN",
      "positionId",       String(askPosition.id),
      "userId",           String(askPosition.userId),
      "market",           askPosition.market,
      "type",             askPosition.type,
      "liquidationPrice", String(askPosition.liquidationPrice),
      "margin",           String(askPosition.margin),
      "averagePrice",     String(askPosition.averagePrice),
      "qty",              String(askPosition.qty)
    ),
  ])
}





async function ensure_fills_consumer_group(){
  try{
    await (redis as any).call("XGROUP","CREATE",FILLS_STREAM,FILLS_GROUP,"$","MKSTREAM")
  }catch(e:any){
    if(!String(e?.message).includes("BUSYGROUP")) throw e
  }
}

async function start_fills_consumer(){
  await ensure_fills_consumer_group()
  console.log(`API consuming fills stream "${FILLS_STREAM}"`)

  while(true){
    const result = await (redis as any).call(
      "XREADGROUP","GROUP",FILLS_GROUP,FILLS_CONSUMER,
      "COUNT","10","BLOCK","0","STREAMS",FILLS_STREAM,">"
    ) as [[string,[string,string[]][]]] | null
    
    if(!result) continue

    const [[,messages]] = result
    for(const [id,fieldsArray] of messages){
      try{
        await processFill(parseFields(fieldsArray))
    }catch(e){
      console.error( `Failed to process fill ${id}`,e)
    }
    await (redis as any).call("XACK",FILLS_STREAM,FILLS_GROUP,id)
  }
}
}



const LIQ_STREAM   = "liquidations"
const LIQ_GROUP    = "api-liquidations"
const LIQ_CONSUMER = "consumer-1"

async function ensure_liquidations_consumer_group(){
  try{
    await (redis as any).call("XGROUP","CREATE",LIQ_STREAM,LIQ_GROUP,"$","MKSTREAM")
  }catch(e:any){
    if(!String(e?.message).includes("BUSYGROUP")) throw e
  }
}

async function start_liquidations_consumer(){
  await ensure_liquidations_consumer_group()
  console.log(`API consuming liquidations stream "${LIQ_STREAM}"`)

  while(true){
    const result = await (redis as any).call(
      "XREADGROUP","GROUP",LIQ_GROUP,LIQ_CONSUMER,
      "COUNT","10","BLOCK","0","STREAMS",LIQ_STREAM,">"
    ) as [[string,[string,string[]][]]] | null

    if(!result) continue

    const [[,messages]] = result
    for(const [id,fieldsArray] of messages){
      try{
        const f = parseFields(fieldsArray)
        const positionId = Number(f.positionId)
        const userId     = Number(f.userId)
        const margin     = Number(f.margin)

        await prisma.$transaction([
          prisma.position.update({
            where: { id: positionId },
            data:  { status: "CLOSED" }
          }),
          prisma.collateral.updateMany({
            where: { userId },
            data:  { locked: { decrement: BigInt(margin) } }
          })
        ])

        await (redis as any).xadd(
          "positions", "*",
          "action",     "CLOSE",
          "positionId", String(positionId)
        )
      }catch(e){
        console.error(`Failed to process liquidation ${id}:`, e)
      }
      await (redis as any).call("XACK",LIQ_STREAM,LIQ_GROUP,id)
    }
  }
}

app.listen(3000, () => {
  console.log("Server running on port 3000");
});

start_fills_consumer().catch(console.error)
start_liquidations_consumer().catch(console.error)