import {
  Logger,
  MedusaContainer,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/medusa";
import { Request, Response } from "express";
import manageFulfillmentsWorkflow from "../../../workflows/manage-fulfillments-workflow";
import { EntityManager } from "typeorm";

// const manageFulfillmentsWorkflow = null;

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const container: MedusaContainer = req.scope;
  const logger: Logger = container.resolve("logger");

  console.log("Manage Fulfillments Handler Invoked");


  if (!req.user || !req.user.id) {
    res.sendStatus(401);
    return;
  }

  const loggedInUser: any = req.user;
  logger.info(
    `Invoking manage-fulfillments workflow for ${loggedInUser.email}`
  );

  // Expecting the POST body to contain whatever payload the workflow needs,
  // e.g. { order_id, items, location_id, ... }
  const payload = req.body ?? {};

  try {
    // Try the imported workflow first; fall back to a container-registered workflow if present.
    let workflowFn: any =
      typeof manageFulfillmentsWorkflow === "function"
        ? manageFulfillmentsWorkflow
        : null;

    // If not provided via import, try resolving from the container safely (resolve may throw if not registered).
    if (!workflowFn) {
      try {
        const resolved = container.resolve("manageFulfillmentsWorkflow");
        workflowFn = typeof resolved === "function" ? resolved : null;
      } catch {
        workflowFn = null;
      }
    }

    if (!workflowFn) {
      logger.error("manage-fulfillments workflow not available");
      res.status(500).json({ ok: false, message: "Workflow not available" });
      return;
    }

    // Call the workflow. The workflow signature may vary; adjust if needed.
    const { result } = await workflowFn(req.scope).run({
      input: {
        user: loggedInUser,
        user_id: loggedInUser.id,
        ...payload,
      },
    });
  

    res.status(200).json({ ok: true, result });
  } catch (error: any) {
    logger.error("Error running manage-fulfillments workflow", error);
    res
      .status(500)
      .json({ ok: false, message: error?.message ?? String(error) });
  }
};
