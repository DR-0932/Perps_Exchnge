import {z} from 'zod'

export const orderSchema = z.discriminatedUnion("type",[
  z.object({
    type:z.literal("LONG"),
    market:z.string(),
    orderType:z.enum(["MARKET","LIMIT"]),
    price:z.number().int().positive(),
    leverage:z.number().int().positive(),
    qty:z.number().int().positive()
  }),
  z.object({
    type:z.literal("SHORT"),
    market:z.string(),
    orderType:z.enum(["MARKET","LIMIT"]),
    price:z.number().int().positive(),
    leverage:z.number().int().positive(),
    qty:z.number().int().positive()
  })
])


export const onrampSchema = z.object({
  amount:z.number().positive()
})