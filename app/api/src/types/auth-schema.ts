import {z} from 'zod'

export const authSchema = z.object({
  username:z.string().trim().min(4,"Minimum 4 characters required"),
  password:z.string().trim().min(6,"minimum 6 characters required"),
})