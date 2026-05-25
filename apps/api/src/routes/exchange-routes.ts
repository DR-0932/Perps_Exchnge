import { Router } from "express";
import { authMiddleware } from "../middlewares/auth";
import { Order, onRamp, cancelOrder, equityAvl, openPosition, closedPosition, getOrder, openOrder, closedOrder, getFills } from "../controllers/exchange-controllers";

export const exchangeRouter = Router();

exchangeRouter.post('/order', authMiddleware, Order)
exchangeRouter.delete('/order/:orderId', authMiddleware, cancelOrder)
exchangeRouter.post('/onramp', authMiddleware, onRamp)

exchangeRouter.get('/equity/available', authMiddleware, equityAvl)

exchangeRouter.get('/positions/open/:marketId', authMiddleware, openPosition)
exchangeRouter.get('/positions/closed/:marketId', authMiddleware, closedPosition)

exchangeRouter.get('/orders/open/:marketId', authMiddleware, openOrder)
exchangeRouter.get('/orders/closed/:marketId', authMiddleware, closedOrder)
exchangeRouter.get('/orders/:marketId', authMiddleware, getOrder)

exchangeRouter.get('/fills', authMiddleware, getFills)
