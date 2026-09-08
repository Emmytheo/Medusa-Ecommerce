import { Router } from "express";
// import { wrapHandler } from "@medusajs/medusa";
import onboardingRoutes from "./onboarding";
import customRouteHandler from "./custom-route-handler";
import manageFulfillmentsRoutes from "./manage-fulfillments";
// import manageFulfillmentsHandler from "./manage-fulfillments/route";
import { wrapHandler } from "@medusajs/utils"
// import { GET as auditWalletGet } from "../../admin/audit-wallet/route";
// import { GET as validateWalletGet } from "../../admin/validate-wallet/route";
import { POST as auditWalletPost } from "../../admin/audit-wallet/route";
import { POST as validateWalletPost } from "../../admin/validate-wallet/route";

// import auditWalletSystem from "./audit-wallet-system";

import vendorWalletRoutes from "./vendor-wallet";
import vendorOnboardingRoutes from "./vendor-onboarding";
import attachNotificationRoutes from "./notification-routes";

// Initialize a custom router
const router = Router();

export function attachAdminRoutes(adminRouter: Router) {
  console.log("Attaching custom admin routes...");
  // Attach our router to a custom path on the admin router
  adminRouter.use("/custom", router);
  // Define a GET endpoint on the root route of our custom path
  router.get("/", wrapHandler(customRouteHandler));

  adminRouter.post("/audit-wallet", wrapHandler(auditWalletPost));
  adminRouter.post("/validate-wallet", wrapHandler(validateWalletPost));

  adminRouter.get("/ping", (req, res) => {
    console.log("Ping route hit!");
    res.json({ message: "pong" });
  });

  // Alias /admin/vendor-wallet -> /admin/vendor/wallet
  adminRouter.get("/vendor-wallet", (req, res) => {
    res.redirect(307, "/admin/vendor/wallet");
  });

  // Normalize store updates from V2 client before core validator runs
  adminRouter.use("/store", (req, res, next) => {
    if (req.method === "POST" && req.body) {
      if (req.body.supported_currencies && Array.isArray(req.body.supported_currencies)) {
        const currencies: string[] = [];
        let defaultCurrency: string | undefined;
        for (const item of req.body.supported_currencies) {
          const code = item.currency_code?.toLowerCase();
          if (code) {
            currencies.push(code);
            if (item.is_default) defaultCurrency = code;
          }
        }
        if (currencies.length > 0) req.body.currencies = currencies;
        if (defaultCurrency) req.body.default_currency_code = defaultCurrency;
        delete req.body.supported_currencies;
      }
      if (req.body.default_region_id) {
        if (!req.body.metadata) req.body.metadata = {};
        req.body.metadata.default_region_id = req.body.default_region_id;
        delete req.body.default_region_id;
      }
    }
    next();
  });

  // Scoped team/users endpoint: only return team members belonging to the current vendor's store
  adminRouter.get("/users", wrapHandler(async (req, res) => {
    const userService = req.scope.resolve("userService");
    let loggedInUser: any;
    try {
      loggedInUser = req.scope.resolve("loggedInUser");
    } catch (_) {}
    const userId = loggedInUser?.id || (req as any).user?.id || (req as any).user?.userId;
    if (!userId) {
      res.status(401).json({ message: "Not logged in" });
      return;
    }
    const currentUser = await userService.retrieve(userId, {
      relations: ["store"],
    });

    const isSuperAdmin = currentUser.role === "admin" && !currentUser.store_id;
    let users: any[] = [];
    let count = 0;

    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 20;

    if (isSuperAdmin) {
      const userRepo = req.scope.resolve("userRepository");
      [users, count] = await userRepo.findAndCount({
        skip: offset,
        take: limit,
      });
    } else {
      const storeId = currentUser.store_id;
      if (storeId) {
        const userRepo = req.scope.resolve("userRepository");
        [users, count] = await userRepo.findAndCount({
          where: { store_id: storeId },
          skip: offset,
          take: limit,
        });
      } else {
        users = [currentUser];
        count = 1;
      }
    }

    users.forEach((u) => {
      delete u.password_hash;
    });

    res.status(200).json({ users, count, offset, limit });
  }));

  // Endpoints for Medusa v2 admin client retrieveMe compatibility
  adminRouter.get("/users/me", wrapHandler(async (req, res) => {
    const userService = req.scope.resolve("userService");
    let loggedInUser: any;
    try {
      loggedInUser = req.scope.resolve("loggedInUser");
    } catch (_) {}
    const userId = loggedInUser?.id || (req as any).user?.id || (req as any).user?.userId;
    if (!userId) {
      res.status(401).json({ message: "Not logged in" });
      return;
    }
    const user = await userService.retrieve(userId, {
      relations: ["store", "wallet"],
    });
    if (user) {
      delete user.password_hash;
      if (!user.metadata) user.metadata = {};
      // Set email_verified flag if metadata has email_verified or default to verified when authenticated
      user.metadata.email_verified = user.metadata.email_verified ?? true;
    }
    res.status(200).json({ user });
  }));

  adminRouter.post("/users/me", wrapHandler(async (req, res) => {
    const userService = req.scope.resolve("userService");
    let loggedInUser: any;
    try {
      loggedInUser = req.scope.resolve("loggedInUser");
    } catch (_) {}
    const userId = loggedInUser?.id || (req as any).user?.id || (req as any).user?.userId;
    if (!userId) {
      res.status(401).json({ message: "Not logged in" });
      return;
    }
    const updated = await userService.update(userId, req.body);
    if (updated) {
      delete updated.password_hash;
    }
    res.status(200).json({ user: updated });
  }));

  // Attach routes for onboarding experience, defined separately
  onboardingRoutes(adminRouter);
  manageFulfillmentsRoutes(adminRouter);
  vendorOnboardingRoutes(adminRouter);
  vendorWalletRoutes(adminRouter);
  attachNotificationRoutes(adminRouter);
}
