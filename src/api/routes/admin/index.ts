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
