import { UserService } from "@medusajs/medusa";
import { User } from "../../models/user";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";
import cookie from "cookie";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY! // service role secret
);

export async function registerLoggedInUser(req, res, next) {
  let loggedInUser: User | null = null;
  const userService = req.scope.resolve("userService") as UserService;

  const isAdminRoute = req.originalUrl.startsWith("/admin");

  
  // console.log(req.headers);
  const supabaseToken = req.headers["sb-access-token"]; // fallback key

  // If Supabase token exists, verify it first
  if (supabaseToken && isAdminRoute) {
    try {
      const { data, error } = await supabase.auth.getUser(supabaseToken);

      if (error || !data.user || (!data.user.email && !data.user.phone)) {
        res.clearCookie("jwt");
        console.warn(
          "[registerLoggedInUser] Invalid Supabase token:",
          error?.message
        );
        return res
          .status(401)
          .json({ message: "Unauthorized: Invalid Supabase session" });
      }

      const userIdentity = data.user;

      const searchParams: any = {};
      if (userIdentity.email) searchParams.email = userIdentity.email;
      else if (userIdentity.phone) searchParams.phone = userIdentity.phone;

      const medusaUsers = await userService.list(searchParams, { take: 1 });

      if (medusaUsers.length === 0) {
        res.clearCookie("jwt");
        return res.status(403).json({
          message: "Forbidden: Supabase user not registered in Medusa",
        });
      }

      console.log(medusaUsers[0]);
      loggedInUser = medusaUsers[0];

      // Re-issue a fresh Medusa JWT
      const medusaJwt = jwt.sign(
        { user_id: loggedInUser.id },
        process.env.JWT_SECRET!,
        { expiresIn: "30d" }
      );

      res.cookie("jwt", medusaJwt, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
      });
    } catch (err) {
      res.clearCookie("jwt");
      console.error(
        "[registerLoggedInUser] Supabase verification failed:",
        err
      );
      return res
        .status(401)
        .json({ message: "Unauthorized: Supabase verification failed" });
    }
  }

  

  // If not found via Supabase, try Medusa JWT fallback
  if (!loggedInUser && (req.user?.id || req.user?.userId) && isAdminRoute) {
    let userId = req.user.id || req.user.userId;
    try {
      loggedInUser = await userService.retrieve(userId, {
        select: ["id", "store_id"],
      });
    } catch (err) {
      res.clearCookie("jwt");
      console.error("[registerLoggedInUser] Medusa JWT invalid:", err);
      return res
        .status(401)
        .json({ message: "Unauthorized: Medusa JWT invalid" });
    }
  }

  req.scope.register({
    loggedInUser: {
      resolve: () => loggedInUser,
    },
  });

  if (!loggedInUser && isAdminRoute) {
    return res
      .status(401)
      .json({ message: "Unauthorized: No valid user session" });
  }

  next();
}
