import { orderbooks } from "../orderbook/orderbook"
import { check_liquidations } from "../liquidation/liquidation-engine"
import { update_pnl } from "../pnl/pnl-updated"
import { redis } from "../db"

export const mark_prices = new Map<string,number>()


// const symbol_map: Record<string,string> ={
//     BTCUSDT:"BTRC-USDT",
//     ETHUSDT:"ETH-USDT",
//     SOLUSDT:"SQL-USDT",
// }

function to_market(binance_symbol: string):string{
    return binance_symbol.slice(0,-4) + "-" + binance_symbol.slice(-4)
}

const stream = [...orderbooks.keys()]
.map(m=> m.replace("-","").toLowerCase()+ "@markPrice@1s")
.join("/")

const WS_URL = `wss://fstream.binance.com/stream?streams=${stream}`

export function connect_mark_price_feed():void{
    const ws=  new WebSocket(WS_URL);

    ws.onmessage = (event) =>{
        const msg = JSON.parse(event.data as string)
        const data =msg.data
        if(data?.e ==="markPriceUpdate"){
            const market =to_market(data.s)
            if(market) {
            const price = Math.round(parseFloat(data.p) * 100)
            mark_prices.set(market, price)
            ;(redis as any).hset("mark_prices", market, String(price))
            check_liquidations(market, price)
            update_pnl(market, price)
        }
        }
    }
    ws.onclose=() =>{
        console.log("Binance WS disconnected - reconnecting in 3d")
        setTimeout(connect_mark_price_feed,3000)
    }
    
    ws.onerror = (e) => console.error("Binance WS error:",e)
}