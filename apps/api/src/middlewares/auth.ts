import type { Request,Response,NextFunction } from 'express'
import jwt from 'jsonwebtoken'

export interface Tokenpayload{
  userId:number;
}




export function authMiddleware(req:Request,res:Response,next:NextFunction):void{

  const authHeader = req.headers.authorization;
  
  
  const token = typeof authHeader ==="string" && authHeader.startsWith('Bearer ')
  ? authHeader.slice(7)
  :undefined;

  if(!token){
    res.status(401).json({error:"Missing auth token"});
    return;
  }
  try{
    const secret = process.env.JWT_SECRET
  if(!secret){
    throw new Error("JWT_SECRET is not set")
  }
  
    const payload = jwt.verify(token,secret) as Tokenpayload
    req.userId =payload.userId;
    next();
  }catch{
    res.status(401).json({error:"Invalid auth token"})
  }

}