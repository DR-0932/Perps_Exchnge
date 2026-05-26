import type { Request,Response} from "express";
import {prisma} from '../db'
import { authSchema } from "../types/auth-schema";
import jwt from 'jsonwebtoken'

export interface TokenPayload {
  userId: number;
}

/* */
function createToken(payload:TokenPayload):string{
  const secret = process.env.JWT_SECRET
  if(!secret) throw new Error("JWT_SECRET is not set")
    return jwt.sign(payload,secret)
}


export async function signup(req:Request,res:Response):Promise<void> {
  const parsedBody = authSchema.safeParse(req.body);
  
  if(!parsedBody.success){
    res.status(400).json({error:parsedBody.error})
    return
  }

  const{username,password} = parsedBody.data
  const passwordHash = await Bun.password.hash(password,{
    algorithm:"bcrypt",
    cost:10
  })

  try{
    const user = await prisma.user.create({
      data:{
        username,
        password:passwordHash
      }

    });
    res.status(201).json({
      token: createToken({userId: user.id}),
      userId: user.id,
      username: user.username,
    })
  }catch{
    res.status(409).json({error:" user already exists"})
  }

}

export async function signin(req:Request,res:Response):Promise<void>{
  const parsedBody = authSchema.safeParse(req.body);
  if(!parsedBody.success){
    res.status(409).json({
      error:parsedBody.error
    })
    return
  }

    const {username,password} = parsedBody.data;

    const user = await prisma.user.findUnique({where:{username}});
    if(!user){
      res.status(401).json({error:"Invalid credentials"});
      return
    }

    const isMatch = await Bun.password.verify(password,user.password);
    if(!isMatch){
      res.status(401).json({error:"Invalid credentials"})
      return
    }

    res.json({
      token:createToken({userId:user.id}),
      userId:user.id,
      username:user.username
    })

}