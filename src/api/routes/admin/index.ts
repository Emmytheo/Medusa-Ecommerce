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

  // router.post("/audit-wallet", wrapHandler(auditWalletSystem));
  // router.post("/", wrapHandler(manageFulfillmentsHandler));
  // Attach routes for onboarding experience, defined separately
  onboardingRoutes(adminRouter);
  manageFulfillmentsRoutes(adminRouter);
}
