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

  // Helper to fetch store data for a given store ID
  const fetchStoreDetails = async (manager: any, storeId: string, req: any) => {
    const featureFlagRouter = req.scope.resolve("featureFlagRouter");
    const paymentProviderService = req.scope.resolve("paymentProviderService");
    const fulfillmentProviderService = req.scope.resolve("fulfillmentProviderService");

    const storeRes = await manager.query("SELECT * FROM store WHERE id = $1", [storeId]);
    if (!storeRes.rows || storeRes.rows.length === 0) return null;
    const storeData = storeRes.rows[0];

    const curRes = await manager.query(
      `SELECT c.* FROM currency c 
       INNER JOIN store_currencies sc ON sc.currency_code = c.code 
       WHERE sc.store_id = $1`,
      [storeId]
    ).catch(() => ({ rows: [] }));

    if (curRes.rows && curRes.rows.length > 0) {
      storeData.currencies = curRes.rows;
    } else {
      const defCode = storeData.default_currency_code || "ngn";
      const defCur = await manager.query(
        "SELECT * FROM currency WHERE code = $1",
        [defCode]
      ).catch(() => ({ rows: [] }));
      storeData.currencies = defCur.rows || [];
    }

    if (storeData.default_sales_channel_id) {
      const scRes = await manager.query(
        "SELECT * FROM sales_channel WHERE id = $1",
        [storeData.default_sales_channel_id]
      ).catch(() => ({ rows: [] }));
      if (scRes.rows && scRes.rows.length > 0) {
        storeData.default_sales_channel = scRes.rows[0];
      }
    }

    storeData.feature_flags = featureFlagRouter && featureFlagRouter.listFlags ? featureFlagRouter.listFlags() : {};
    storeData.modules = [];
    try {
      storeData.payment_providers = await paymentProviderService.list();
    } catch (_) {
      storeData.payment_providers = [];
    }
    try {
      storeData.fulfillment_providers = await fulfillmentProviderService.list();
    } catch (_) {
      storeData.fulfillment_providers = [];
    }

    return storeData;
  };

  // Scoped store endpoint: returns the store of the logged in user
  adminRouter.get("/store", wrapHandler(async (req, res) => {
    const userId = getUserIdFromRequest(req);
    const userService = req.scope.resolve("userService");
    const manager = req.scope.resolve("manager");

    let targetStoreId: string | null = null;
    if (userId) {
      try {
        const currentUser = await userService.retrieve(userId, { relations: ["store"] });
        targetStoreId = currentUser.store_id || (currentUser.metadata as any)?.store_id;
      } catch (e) {}
    }

    if (req.query.store_id && typeof req.query.store_id === "string") {
      targetStoreId = req.query.store_id;
    } else if (req.headers["x-store-id"] && typeof req.headers["x-store-id"] === "string") {
      targetStoreId = req.headers["x-store-id"] as string;
    }

    if (!targetStoreId && userId) {
      const owned = await manager.query(
        "SELECT id FROM store WHERE metadata->>'vendor_user_id' = $1 LIMIT 1",
        [userId]
      ).catch(() => ({ rows: [] }));
      if (owned.rows && owned.rows.length > 0) {
        targetStoreId = owned.rows[0].id;
      }
    }

    if (!targetStoreId) {
      const fallback = await manager.query("SELECT id FROM store ORDER BY created_at ASC LIMIT 1");
      if (fallback.rows && fallback.rows.length > 0) {
        targetStoreId = fallback.rows[0].id;
      }
    }

    const storeData = await fetchStoreDetails(manager, targetStoreId, req);
    if (!storeData) {
      res.status(404).json({ message: "Store not found" });
      return;
    }

    res.status(200).json({ store: storeData });
  }));

  // Plural stores endpoint for V2 compatibility
  adminRouter.get("/stores", wrapHandler(async (req, res) => {
    const userId = getUserIdFromRequest(req);
    const userService = req.scope.resolve("userService");
    const manager = req.scope.resolve("manager");

    let targetStoreId: string | null = null;
    if (userId) {
      try {
        const currentUser = await userService.retrieve(userId, { relations: ["store"] });
        targetStoreId = currentUser.store_id || (currentUser.metadata as any)?.store_id;
      } catch (e) {}
    }

    if (req.query.store_id && typeof req.query.store_id === "string") {
      targetStoreId = req.query.store_id;
    } else if (req.headers["x-store-id"] && typeof req.headers["x-store-id"] === "string") {
      targetStoreId = req.headers["x-store-id"] as string;
    }

    if (!targetStoreId && userId) {
      const owned = await manager.query(
        "SELECT id FROM store WHERE metadata->>'vendor_user_id' = $1 LIMIT 1",
        [userId]
      ).catch(() => ({ rows: [] }));
      if (owned.rows && owned.rows.length > 0) {
        targetStoreId = owned.rows[0].id;
      }
    }

    if (!targetStoreId) {
      const fallback = await manager.query("SELECT id FROM store ORDER BY created_at ASC LIMIT 1");
      if (fallback.rows && fallback.rows.length > 0) {
        targetStoreId = fallback.rows[0].id;
      }
    }

    const storeData = await fetchStoreDetails(manager, targetStoreId, req);
    if (!storeData) {
      res.status(200).json({ stores: [], count: 0, limit: 10, offset: 0 });
      return;
    }

    res.status(200).json({
      stores: [storeData],
      count: 1,
      limit: 10,
      offset: 0,
    });
  }));

  // Scoped store update: updates the store of the logged in user
  adminRouter.post("/store", wrapHandler(async (req, res) => {
    const userId = getUserIdFromRequest(req);
    const userService = req.scope.resolve("userService");
    const manager = req.scope.resolve("manager");

    let targetStoreId: string | null = null;
    if (userId) {
      try {
        const currentUser = await userService.retrieve(userId);
        targetStoreId = currentUser.store_id || (currentUser.metadata as any)?.store_id;
      } catch (e) {}
    }

    if (req.query.store_id && typeof req.query.store_id === "string") {
      targetStoreId = req.query.store_id;
    } else if (req.headers["x-store-id"] && typeof req.headers["x-store-id"] === "string") {
      targetStoreId = req.headers["x-store-id"] as string;
    }

    if (!targetStoreId) {
      res.status(400).json({ message: "Store not found for user" });
      return;
    }

    const { name, default_currency_code, currencies, metadata } = req.body;
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(name);
    }
    if (default_currency_code !== undefined) {
      updates.push(`default_currency_code = $${idx++}`);
      values.push(default_currency_code.toLowerCase());
    }
    if (metadata !== undefined) {
      updates.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${idx++}::jsonb`);
      values.push(JSON.stringify(metadata));
    }

    if (updates.length > 0) {
      updates.push(`updated_at = NOW()`);
      values.push(targetStoreId);
      await manager.query(
        `UPDATE store SET ${updates.join(", ")} WHERE id = $${idx}`,
        values
      );
    }

    if (Array.isArray(currencies)) {
      await manager.query("DELETE FROM store_currencies WHERE store_id = $1", [targetStoreId]);
      for (const code of currencies) {
        await manager.query(
          "INSERT INTO store_currencies (store_id, currency_code) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [targetStoreId, code.toLowerCase()]
        ).catch(() => {});
      }
    }

    const updatedStore = await fetchStoreDetails(manager, targetStoreId, req);
    res.status(200).json({ store: updatedStore });
  }));

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
    let orgDetails: any = null;
    if (!logisticsOrgId) {
      const org = await getLogisticsOrgForUser(manager, userId, currentUser.email, currentUser.metadata?.logistics_org_id);
      if (org) {
        logisticsOrgId = org.id;
        orgDetails = org;
        if (!currentUser.metadata) currentUser.metadata = {};
        currentUser.metadata.logistics_org_id = logisticsOrgId;
        currentUser.metadata.logistics_org_name = org.name;
        await userService.update(userId, { metadata: currentUser.metadata }).catch(() => {});
      }
    } else {
      const orgRes = await manager.query('SELECT * FROM "logistics_orgs" WHERE id = $1', [logisticsOrgId]).catch(() => ({ rows: [] }));
      if (orgRes.rows && orgRes.rows.length > 0) {
        orgDetails = orgRes.rows[0];
      }
    }

    const requestedScope = (req.query.scope || req.headers["x-app-scope"] || "").toString().toLowerCase();
    const requestedStoreId = (req.query.store_id || req.headers["x-store-id"] || "").toString();
    const requestedLogisticsOrgId = (req.query.logistics_org_id || req.headers["x-logistics-org-id"] || "").toString();

    const isSuperAdmin = currentUser.role === "admin" && !currentUser.store_id && !logisticsOrgId && !requestedScope;
    let users: any[] = [];
    let count = 0;

    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 20;
    const userRepo = req.scope.resolve("userRepository");

    const isLogisticsContext = requestedScope === "logistics" || requestedScope === "rider" || (requestedLogisticsOrgId && requestedLogisticsOrgId !== "null") || (!requestedScope && logisticsOrgId && !currentUser.store_id);

    if (isSuperAdmin) {
      [users, count] = await userRepo.findAndCount({
        skip: offset,
        take: limit,
      });
    } else if (isLogisticsContext) {
      const targetOrgId = requestedLogisticsOrgId || logisticsOrgId;
      const allUsers = await userRepo.find();
      const matched = allUsers.filter((u: any) => {
        const uOrgId = (u.metadata?.logistics_org_id || "").toString();
        return uOrgId === targetOrgId;
      });

      // Enrich metadata with verified role in this logistics org
      matched.forEach((u: any) => {
        if (!u.metadata) u.metadata = {};
        const isAdmin = (orgDetails && orgDetails.contact_info?.admin_user_id === u.id) ||
                        u.metadata.account_type === "logistics_org" ||
                        u.metadata.logistics_role === "admin" ||
                        (u.role && u.role.toLowerCase() === "admin");
        u.metadata.logistics_role = isAdmin ? "admin" : (u.metadata.logistics_role || "staff");
      });

      count = matched.length;
      users = matched.slice(offset, offset + limit);
    } else {
      // Vendor Store Context
      const targetStoreId = requestedStoreId || currentUser.store_id || currentUser.metadata?.store_id;
      if (targetStoreId) {
        const allUsers = await userRepo.find();
        const matched = allUsers.filter((u: any) => {
          return u.store_id === targetStoreId || u.metadata?.store_id === targetStoreId;
        });

        matched.forEach((u: any) => {
          if (!u.metadata) u.metadata = {};
          const isOwner = u.store_id === targetStoreId && (u.metadata.account_type === "vendor" || !u.metadata.account_type?.includes("staff") || u.role === "admin");
          u.metadata.vendor_role = isOwner ? "owner" : "staff";
        });

        count = matched.length;
        users = matched.slice(offset, offset + limit);
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

    const requestedScope = (req.query.scope || req.headers["x-app-scope"] || "").toString().toLowerCase();
    const requestedStoreId = (req.query.store_id || req.headers["x-store-id"] || "").toString();
    const requestedLogisticsOrgId = (req.query.logistics_org_id || req.headers["x-logistics-org-id"] || "").toString();

    const isLogisticsContext = requestedScope === "logistics" || requestedScope === "rider" || (requestedLogisticsOrgId && requestedLogisticsOrgId !== "null");

    const allInvites = await inviteService.list({});
    let filtered = allInvites;

    if (currentUser.role !== "admin" || currentUser.store_id || logisticsOrgId || requestedScope) {
      filtered = allInvites.filter((inv: any) => {
        const invOrgId = (inv.metadata?.logistics_org_id || "").toString();
        const invStoreId = (inv.metadata?.store_id || "").toString();

        if (isLogisticsContext) {
          const targetOrgId = requestedLogisticsOrgId || logisticsOrgId;
          return invOrgId === targetOrgId;
        } else {
          const targetStoreId = requestedStoreId || currentUser.store_id;
          return invStoreId === targetStoreId;
        }
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
    let orgDetails: any = null;

    if (!logisticsOrgId) {
      const org = await getLogisticsOrgForUser(manager, userId, currentUser.email, currentUser.metadata?.logistics_org_id);
      if (org) {
        logisticsOrgId = org.id;
        logisticsOrgName = org.name;
        orgDetails = org;
      }
    } else {
      const orgRes = await manager.query('SELECT * FROM "logistics_orgs" WHERE id = $1', [logisticsOrgId]).catch(() => ({ rows: [] }));
      if (orgRes.rows && orgRes.rows.length > 0) {
        orgDetails = orgRes.rows[0];
      }
    }

    const requestedScope = (req.body.scope || req.query.scope || req.headers["x-app-scope"] || "").toString().toLowerCase();
    const isLogisticsContext = requestedScope === "logistics" || requestedScope === "rider" || (!requestedScope && logisticsOrgId && !currentUser.store_id);

    const targetEmail = (req.body.user || req.body.email || "").toString().trim().toLowerCase();
    const invitedRole = (req.body.role || req.body.logistics_role || "staff").toString().toLowerCase();

    if (!targetEmail) {
      res.status(400).json({ type: "invalid_data", message: "Email parameter is required" });
      return;
    }

    // Check permissions!
    if (isLogisticsContext) {
      const isOrgAdmin = currentUser.role === "admin" ||
                         currentUser.metadata?.account_type === "logistics_org" ||
                         currentUser.metadata?.logistics_role === "admin" ||
                         (orgDetails && orgDetails.contact_info?.admin_user_id === userId);

      if (!isOrgAdmin) {
        res.status(403).json({
          type: "unauthorized",
          message: "Only organization administrators can invite staff or couriers to this logistics firm."
        });
        return;
      }
    }

    // Check if user with this email already exists
    const existingUser = await userRepo.findOne({ where: { email: targetEmail } });

    if (existingUser) {
      if (isLogisticsContext && logisticsOrgId) {
        const existingOrgId = (existingUser.metadata?.logistics_org_id || "").toString();
        if (existingOrgId === logisticsOrgId) {
          res.status(400).json({
            type: "invalid_data",
            message: `User ${targetEmail} is already a member in ${logisticsOrgName || "your organization"}.`
          });
          return;
        }

        // Attach user to this Logistics Org WITHOUT clobbering their vendor store identity!
        const existingScopes = Array.isArray(existingUser.metadata?.allowed_scopes)
          ? existingUser.metadata.allowed_scopes
          : ["vendor"];
        const updatedScopes = Array.from(new Set([...existingScopes, "logistics", "rider"]));

        const newMeta = {
          ...(existingUser.metadata || {}),
          logistics_org_id: logisticsOrgId,
          logistics_org_name: logisticsOrgName || "Swift Air",
          logistics_role: invitedRole === "admin" ? "admin" : (invitedRole === "rider" ? "rider" : "staff"),
          allowed_scopes: updatedScopes
        };

        // If they already have a store, preserve their account_type as vendor or store owner
        if (!newMeta.account_type || newMeta.account_type === "logistics_staff") {
          if (existingUser.store_id) {
            newMeta.account_type = "vendor";
          }
        }

        await userRepo.update({ id: existingUser.id }, { metadata: newMeta });

        res.status(200).json({
          invite: {
            id: `inv_attached_${Date.now()}`,
            user_email: targetEmail,
            role: invitedRole,
            accepted: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: {
              logistics_org_id: logisticsOrgId,
              logistics_role: newMeta.logistics_role,
              note: "Existing user attached to logistics fleet"
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
            role: invitedRole,
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
      const invite = await inviteService.create(targetEmail, invitedRole);
      const inviteMeta = {
        ...(invite.metadata || {}),
        logistics_org_id: isLogisticsContext ? (logisticsOrgId || undefined) : undefined,
        logistics_role: isLogisticsContext ? (invitedRole === "admin" ? "admin" : "staff") : undefined,
        store_id: !isLogisticsContext ? (currentUser.store_id || undefined) : undefined,
        account_type: isLogisticsContext ? "logistics_staff" : "vendor_staff"
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
