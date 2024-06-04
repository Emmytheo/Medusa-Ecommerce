import { UserService } from "@medusajs/medusa"
import { User } from "../../models/user"

export async function registerLoggedInUser(req, res, next) {
  let loggedInUser: User | null = null

  if (req.user && req.user.userId && req.originalUrl.startsWith('/admin')){
    const userService = 
      req.scope.resolve("userService") as UserService
    loggedInUser = await userService.retrieve(req.user.userId, {
      select: ['id', 'store_id'],
    })
  }

  req.scope.register({
    loggedInUser: {
      resolve: () => loggedInUser,
     },
   })
  
  next()
}