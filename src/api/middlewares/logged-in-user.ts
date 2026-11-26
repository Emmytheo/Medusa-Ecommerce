import { authenticate, UserService } from "@medusajs/medusa";
import { User } from "../../models/user";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!
);

async function resolveUserBySupabaseToken(req: any, res: any, supabaseToken: string): Promise<User | null> {
  const userService = req.scope.resolve("userService") as UserService;
  const manager = req.scope.resolve("manager");

  const { data, error } = await supabase.auth.getUser(supabaseToken);
  if (error || !data?.user || (!data.user.email && !data.user.phone)) {
    return null;
  }

  const userIdentity = data.user;
  let userId: string | null = null;

  if (userIdentity.email) {
    try {
      const rows = await manager.query(
        `SELECT id FROM "user" WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL LIMIT 1`,
        [userIdentity.email]
      );
      if (Array.isArray(rows) && rows.length > 0) {
        userId = rows[0].id;
      }
    } catch (_) {
      const list = await userService.list({ email: userIdentity.email }, { take: 1 });
      if (list.length > 0) userId = list[0].id;
    }
  }

  if (!userId && userIdentity.phone) {
    try {
      const digits = userIdentity.phone.replace(/\D/g, "");
      const rows = await manager.query(
        `SELECT id FROM "user" WHERE deleted_at IS NULL AND (metadata->>'phone' = $1 OR REGEXP_REPLACE(COALESCE(metadata->>'phone', ''), '[^0-9]', '', 'g') = $2) LIMIT 1`,
        [userIdentity.phone, digits]
      );
      if (Array.isArray(rows) && rows.length > 0) {
        userId = rows[0].id;
      }
    } catch (_) {}
  }

  if (!userId) return null;

  const loggedInUser = await userService.retrieve(userId, {
    relations: ["store", "wallet"],
  });

  // Set req.user so Medusa core admin routes & middlewares recognize the authenticated user
  req.user = {
    id: loggedInUser.id,
    userId: loggedInUser.id,
    email: loggedInUser.email,
    role: loggedInUser.role,
  };

  // Issue/refresh Medusa JWT cookie seamlessly
  if (process.env.JWT_SECRET) {
    const medusaJwt = jwt.sign(
      { user_id: loggedInUser.id },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    res.cookie("jwt", medusaJwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    });
  }

  return loggedInUser;
}

export async function registerLoggedInUser(req: any, res: any, next: any) {
  if (req.method === "OPTIONS") return next();

  let loggedInUser: User | null = null;
  const userService = req.scope.resolve("userService") as UserService;
  const isAdminRoute = req.originalUrl.startsWith("/admin");

  const supabaseToken = (req.headers["sb-access-token"] || "").toString().trim();

  // 1. If Supabase access token is supplied, verify it directly
  if (supabaseToken && isAdminRoute) {
    try {
      loggedInUser = await resolveUserBySupabaseToken(req, res, supabaseToken);
      if (!loggedInUser) {
        res.clearCookie("jwt");
        return res.status(401).json({
          message: "Unauthorized: Invalid or unregistered Supabase session",
        });
      }
    } catch (err: any) {
      res.clearCookie("jwt");
      console.error("[registerLoggedInUser] Supabase verification failed:", err?.message || err);
      return res.status(401).json({
        message: "Unauthorized: Supabase verification failed",
      });
    }
  }

  // 2. Fallback: Medusa JWT / Session user populated by authenticate()
  if (!loggedInUser && (req.user?.id || req.user?.userId) && isAdminRoute) {
    const userId = req.user.id || req.user.userId;
    try {
      loggedInUser = await userService.retrieve(userId, {
        relations: ["store", "wallet"],
      });
    } catch (err: any) {
      res.clearCookie("jwt");
      console.error("[registerLoggedInUser] Medusa JWT invalid:", err?.message || err);
      return res.status(401).json({
        message: "Unauthorized: Medusa JWT invalid",
      });
    }
  }

  // 3. Fallback: Bearer token could itself be a Supabase JWT (e.g. from portal/mobile)
  if (!loggedInUser && isAdminRoute && typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")) {
    const bearerToken = req.headers.authorization.slice(7).trim();
    if (bearerToken) {
      try {
        loggedInUser = await resolveUserBySupabaseToken(req, res, bearerToken);
      } catch (_) {}
    }
  }

  req.scope.register({
    loggedInUser: {
      resolve: () => loggedInUser,
    },
  });

  if (!loggedInUser && isAdminRoute) {
    return res.status(401).json({
      message: "Unauthorized: No valid user session",
    });
  }

  return next();
}

/**
 * Unified Admin Auth Middleware:
 * - Allows CORS preflight OPTIONS requests through.
 * - If `sb-access-token` header is present, validates via Supabase + Medusa User lookup BEFORE
 *   Medusa's passport `authenticate()` runs (eliminating the 401 deadlock for Supabase-authenticated portal/app users).
 * - Otherwise delegates to Medusa's native `authenticate()` and then `registerLoggedInUser`.
 */
export function authenticateAdminOrSupabase(req: any, res: any, next: any) {
  if (req.method === "OPTIONS") {
    return next();
  }

  const hasSupabaseHeader = Boolean(
    req.headers["sb-access-token"] &&
      String(req.headers["sb-access-token"]).trim().length > 0
  );

  if (hasSupabaseHeader) {
    return registerLoggedInUser(req, res, next);
  }

  const medusaAuth = authenticate();
  return medusaAuth(req, res, (authErr?: any) => {
    if (authErr) {
      return next(authErr);
    }
    return registerLoggedInUser(req, res, next);
  });
}
