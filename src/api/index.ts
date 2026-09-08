import { Router } from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { authenticate, ConfigModule } from "@medusajs/medusa";
import { getConfigFile } from "medusa-core-utils";
import { registerLoggedInUser } from "./middlewares/logged-in-user"; // Import your old middleware
import { attachStoreRoutes } from "./routes/store";
import { attachAdminRoutes } from "./routes/admin";

export default (rootDirectory: string): Router | Router[] => {
  // Read currently-loaded medusa config
  const { configModule } = getConfigFile<ConfigModule>(
    rootDirectory,
    "medusa-config"
  );
  const { projectConfig } = configModule;

  // Set up our CORS options objects, based on config
  const storeCorsOptions = {
    origin: projectConfig.store_cors.split(","),
    credentials: true,
  };

  const adminCorsOptions = {
    origin: projectConfig.admin_cors.split(","),
    credentials: true,
  };

  // Set up express router
  const router = Router();

  // Set up root routes for store and admin endpoints, with appropriate CORS settings
  router.use("/store", cors(storeCorsOptions), bodyParser.json());
  router.use("/admin", cors(adminCorsOptions), bodyParser.json());

  // Add authentication to all admin routes *except* auth, onboarding, otp, email, and account invite ones
  router.use(
    /\/admin\/((?!auth)(?!invites)(?!vendor\/onboarding)(?!users\/reset-password)(?!users\/password-token)(?!otp)(?!email)(?!send-email).*)/,
    authenticate(),
    registerLoggedInUser // Include your old middleware
  );

  // Set up routers for store and admin endpoints
  const storeRouter = Router();
  const adminRouter = Router();

  // Also support root-level /otp, /email, /send-email matching AWS-SNS-OTP-API paths
  router.get("/otp", (req, res, next) => {
    (adminRouter as any).handle(req, res, next);
  });
  router.post("/email", (req, res, next) => {
    (adminRouter as any).handle(req, res, next);
  });
  router.post("/send-email", (req, res, next) => {
    (adminRouter as any).handle(req, res, next);
  });

  // Support both Medusa v1 and v2 logout endpoints
  const handleLogout = (req: any, res: any) => {
    if (req.session) {
      delete req.session.user_id;
      if (typeof req.session.destroy === "function") {
        req.session.destroy(() => {});
      }
    }
    res.clearCookie("connect.sid");
    res.clearCookie("jwt");
    res.status(200).json({ success: true, message: "Logged out successfully" });
  };

  router.delete("/auth/session", handleLogout);
  router.delete("/admin/auth/session", handleLogout);
  adminRouter.delete("/auth/session", handleLogout);
  adminRouter.delete("/session", handleLogout);

  // Attach these routers to the root routes
  router.use("/store", storeRouter);
  router.use("/admin", adminRouter);

  // Attach custom routes to these routers
  attachStoreRoutes(storeRouter);
  attachAdminRoutes(adminRouter);

  return router;
};
