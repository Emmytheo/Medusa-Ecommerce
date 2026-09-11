import { Router } from "express";
import onboardingRoutes from "./onboarding";
import customRouteHandler from "./custom-route-handler";
import manageFulfillmentsRoutes from "./manage-fulfillments";
import { wrapHandler } from "@medusajs/utils";
import { POST as auditWalletPost } from "../../admin/audit-wallet/route";
import { POST as validateWalletPost } from "../../admin/validate-wallet/route";
import vendorWalletRoutes from "./vendor-wallet";
import vendorOnboardingRoutes from "./vendor-onboarding";
import attachNotificationRoutes from "./notification-routes";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL || "https://eke.afriomarkets.com";
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
  return createClient(url, key);
}

function getUserIdFromRequest(req: any): string | null {
  let loggedInUser: any;
  try {
    loggedInUser = req.scope?.resolve("loggedInUser");
  } catch (_) {}
  if (loggedInUser?.id) return loggedInUser.id;
  if (req.user?.id || req.user?.userId) return req.user.id || req.user.userId;
  if (req.session?.user_id) return req.session.user_id;

  const authHeader = req.headers?.authorization;
  if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    try {
      const token = authHeader.substring(7).trim();
      const payloadBase64 = token.split(".")[1];
      if (payloadBase64) {
        const payload = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));
        if (payload?.user_id || payload?.userId) {
          return payload.user_id || payload.userId;
        }
      }
    } catch (_) {}
  }

  const sbToken = req.headers?.["sb-access-token"];
  if (sbToken && typeof sbToken === "string") {
    try {
      const payloadBase64 = sbToken.split(".")[1];
      if (payloadBase64) {
        const payload = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));
        if (payload?.sub) {
          return payload.sub;
        }
      }
    } catch (_) {}
  }

  return null;
}

async function getLogisticsOrgForUser(manager: any, userId: string, userEmail: string, currentOrgId?: string | null): Promise<{ id: string; name: string } | null> {
  if (currentOrgId) {
    try {
      const rows = await manager.query('SELECT id, name FROM logistics_orgs WHERE id = $1 LIMIT 1', [currentOrgId]);
      if (rows && rows.length > 0) return { id: String(rows[0].id), name: rows[0].name };
    } catch (_) {}
  }
  try {
    const rows = await manager.query(
      `SELECT id, name FROM logistics_orgs 
       WHERE contact_info->>'admin_user_id' = $1 
          OR contact_info->>'contact_email' = $2 
          OR contact_info->>'email' = $2 
       LIMIT 1`,
      [userId, userEmail]
    );
    if (rows && rows.length > 0) {
      return { id: String(rows[0].id), name: rows[0].name };
    }
  } catch (err) {
    console.error("Error finding logistics org via manager:", err);
  }
  return null;
}

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

  // Scoped team/users endpoint: returns team members belonging to vendor store OR logistics org
  adminRouter.get("/users", wrapHandler(async (req, res) => {
    const userService = req.scope.resolve("userService");
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ message: "Not logged in" });
      return;
    }
    const currentUser = await userService.retrieve(userId, {
      relations: ["store"],
    });

    const manager = req.scope.resolve("manager");
    let logisticsOrgId: string | null = (currentUser.metadata?.logistics_org_id || "").toString() || null;
    if (!logisticsOrgId) {
      const org = await getLogisticsOrgForUser(manager, userId, currentUser.email, currentUser.metadata?.logistics_org_id);
      if (org) {
        logisticsOrgId = org.id;
        if (!currentUser.metadata) currentUser.metadata = {};
        currentUser.metadata.logistics_org_id = logisticsOrgId;
        currentUser.metadata.logistics_org_name = org.name;
        await userService.update(userId, { metadata: currentUser.metadata }).catch(() => {});
      }
    }

    const isSuperAdmin = currentUser.role === "admin" && !currentUser.store_id && !logisticsOrgId;
    let users: any[] = [];
    let count = 0;

    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 20;
    const userRepo = req.scope.resolve("userRepository");

    if (isSuperAdmin) {
      [users, count] = await userRepo.findAndCount({
        skip: offset,
        take: limit,
      });
    } else if (logisticsOrgId) {
      const allUsers = await userRepo.find();
      const matched = allUsers.filter((u: any) => {
        const uOrgId = (u.metadata?.logistics_org_id || "").toString();
        return u.id === userId || uOrgId === logisticsOrgId;
      });
      count = matched.length;
      users = matched.slice(offset, offset + limit);
    } else if (currentUser.store_id) {
      [users, count] = await userRepo.findAndCount({
        where: { store_id: currentUser.store_id },
        skip: offset,
        take: limit,
      });
    } else {
      users = [currentUser];
      count = 1;
    }

    users.forEach((u) => {
      delete u.password_hash;
    });

    res.status(200).json({ users, count, offset, limit });
  }));

  // Scoped invites endpoint GET
  adminRouter.get("/invites", wrapHandler(async (req, res) => {
    const userService = req.scope.resolve("userService");
    const inviteService = req.scope.resolve("inviteService");
    const manager = req.scope.resolve("manager");
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ message: "Not logged in" });
      return;
    }
    const currentUser = await userService.retrieve(userId);

    let logisticsOrgId: string | null = (currentUser.metadata?.logistics_org_id || "").toString() || null;
    if (!logisticsOrgId) {
      const org = await getLogisticsOrgForUser(manager, userId, currentUser.email, currentUser.metadata?.logistics_org_id);
      if (org) logisticsOrgId = org.id;
    }

    const allInvites = await inviteService.list({});
    let filtered = allInvites;

    if (currentUser.role !== "admin" || currentUser.store_id || logisticsOrgId) {
      filtered = allInvites.filter((inv: any) => {
        const invOrgId = (inv.metadata?.logistics_org_id || "").toString();
        const invStoreId = (inv.metadata?.store_id || "").toString();
        if (logisticsOrgId && invOrgId === logisticsOrgId) return true;
        if (currentUser.store_id && invStoreId === currentUser.store_id) return true;
        return false;
      });
    }

    res.status(200).json({ invites: filtered, count: filtered.length, offset: 0, limit: 50 });
  }));

  // Scoped invites endpoint POST: Handles new user invitations AND attaching existing accounts to Logistics Org / Vendor Store
  adminRouter.post("/invites", wrapHandler(async (req, res) => {
    const userService = req.scope.resolve("userService");
    const userRepo = req.scope.resolve("userRepository");
    const inviteService = req.scope.resolve("inviteService");
    const inviteRepo = req.scope.resolve("inviteRepository");
    const manager = req.scope.resolve("manager");

    const userId = getUserIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ message: "Not logged in" });
      return;
    }
    const currentUser = await userService.retrieve(userId);

    let logisticsOrgId: string | null = (currentUser.metadata?.logistics_org_id || "").toString() || null;
    let logisticsOrgName: string | null = (currentUser.metadata?.logistics_org_name || "").toString() || null;

    if (!logisticsOrgId) {
      const org = await getLogisticsOrgForUser(manager, userId, currentUser.email, currentUser.metadata?.logistics_org_id);
      if (org) {
        logisticsOrgId = org.id;
        logisticsOrgName = org.name;
      }
    }

    const targetEmail = (req.body.user || req.body.email || "").toString().trim().toLowerCase();
    const role = req.body.role || "member";

    if (!targetEmail) {
      res.status(400).json({ type: "invalid_data", message: "Email parameter is required" });
      return;
    }

    // Check if user with this email already exists
    const existingUser = await userRepo.findOne({ where: { email: targetEmail } });

    if (existingUser) {
      if (logisticsOrgId) {
        const existingOrgId = (existingUser.metadata?.logistics_org_id || "").toString();
        if (existingOrgId === logisticsOrgId) {
          res.status(400).json({
            type: "invalid_data",
            message: `User ${targetEmail} is already a staff member in ${logisticsOrgName || "your organization"}.`
          });
          return;
        }

        // User exists elsewhere, attach them to this Logistics Org!
        const newMeta = {
          ...(existingUser.metadata || {}),
          logistics_org_id: logisticsOrgId,
          logistics_org_name: logisticsOrgName || "Swift Air",
          account_type: "logistics_staff"
        };
        await userRepo.update({ id: existingUser.id }, { metadata: newMeta });

        res.status(200).json({
          invite: {
            id: `inv_attached_${Date.now()}`,
            user_email: targetEmail,
            role: role,
            accepted: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: {
              logistics_org_id: logisticsOrgId,
              account_type: "logistics_staff",
              note: "Existing user added to organization staff"
            }
          }
        });
        return;
      } else if (currentUser.store_id) {
        if (existingUser.store_id === currentUser.store_id) {
          res.status(400).json({
            type: "invalid_data",
            message: `User ${targetEmail} is already a team member in your store.`
          });
          return;
        }
        await userRepo.update({ id: existingUser.id }, { store_id: currentUser.store_id });
        res.status(200).json({
          invite: {
            id: `inv_attached_${Date.now()}`,
            user_email: targetEmail,
            role: role,
            accepted: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: {
              store_id: currentUser.store_id,
              note: "Existing user added to store staff"
            }
          }
        });
        return;
      }
    }

    // Create standard invite for new user
    try {
      const invite = await inviteService.create(targetEmail, role);
      const inviteMeta = {
        ...(invite.metadata || {}),
        logistics_org_id: logisticsOrgId || undefined,
        store_id: currentUser.store_id || undefined,
        account_type: logisticsOrgId ? "logistics_staff" : "vendor_staff"
      };
      await inviteRepo.update({ id: invite.id }, { metadata: inviteMeta });
      invite.metadata = inviteMeta;
      res.status(200).json({ invite });
    } catch (err: any) {
      res.status(400).json({
        type: "invalid_data",
        message: err?.message || "Failed to create invite"
      });
    }
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
