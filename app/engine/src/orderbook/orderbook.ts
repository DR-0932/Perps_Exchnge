// B-tree orderbook
import BTree from "sorted-btree"

export interface Order{
  orderId:number,
  userId:number,
  price:number,
  qty:number,
  leverage:number,
  createdAt:number
}
/*----array of orders at same price bcoz tree can't have multiple keys with same value. Placeholder until redis comes-in */
type price_level = Map<number,Order>

export class Orderbook {
  private bids = new BTree<number, price_level>()
  private asks = new BTree<number,price_level>()


  add_order(order:Order,side:"BID" | "ASK"):void {
    const tree = side ==="BID" ? this.bids : this.asks
    const level = tree.get(order.price)

    if(level){
      level.set(order.orderId,order)
    }else{
      const new_level = new Map<number,Order>()
      new_level.set(order.orderId,order)
      tree.set(order.price,new_level)
    }
  }


  /**return higest buyer in long /bids tree */
  best_bid():Order | undefined{
    const best_bid_price = this.bids.maxKey()

    if(!best_bid_price) return undefined
    const level = this.bids.get(best_bid_price)
    return level?.values().next().value
  }

  /**returns the lowest seller in short /asks tree */
  best_ask():Order | undefined {
    const best_ask_price  = this.asks.minKey();

    if(!best_ask_price) return undefined
    
    const level = this.asks.get(best_ask_price)
    return level?.values().next().value
  }

  /**function to remove/delete orders*/
  remove_order(orderId:number,side:"BID"|"ASK" ,price:number):void{
    const tree = side ==="BID" ? this.bids: this.asks
    const level =tree.get(price)

    if(!level) return
    level.delete(orderId)

    if(level.size===0){
      tree.delete(price) 
    }
  }

  update_order_qty(orderId:number,price:number,side:"BID"|"ASK",newQty:number):void{
    const tree = side ==="BID"? this.bids:this.asks
    const level = tree.get(price)

    if(!level) return

    const order = level.get(orderId)
    if(!order) return

    order.qty = newQty
  }
  
}

export const orderbooks =new Map<string,Orderbook>()

orderbooks.set("BTC-USDT",new Orderbook())
orderbooks.set("ETH-USDT",new Orderbook())
orderbooks.set("SOL-USDT", new Orderbook())
