import { Router } from "express";
import { signin, signup } from "../controllers/auth-controllers";

export const authrouter= Router();

authrouter.post("/signup", signup)
authrouter.post("/signIn", signin)