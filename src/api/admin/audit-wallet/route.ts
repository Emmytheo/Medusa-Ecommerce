import { Request, Response } from "express";
import { MedusaContainer, MedusaRequest, MedusaResponse, User } from "@medusajs/medusa";
import auditWalletWorkflow from "../../../workflows/audit-wallet-workflow";

export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
    const container: MedusaContainer = req.scope;
    const logger = container.resolve("logger");

    // Authentication check (basic, usually handled by middleware but verifying user exists)
    // Assuming req.user is populated by logged-in-user middleware or standard Medusa auth
    // In `custom-route-handler.ts`, it checks `req.user`.

    const user = req.user as User;

    if (!user || !user.store_id) {
        res.status(401).json({ message: "Unauthorized or no store linked" });
        return;
    }

    logger.info(`Starting Wallet Audit for Store: ${user.store_id} by User: ${user.id}`);

    try {
        const { result } = await auditWalletWorkflow(container).run({
            input: {
                store_id: user.store_id,
                admin_user_id: user.id,
            },
        });

        res.status(200).json({
            message: "Wallet Audit Completed",
            result,
        });
    } catch (error) {
        logger.error("Error running wallet audit:", error);
        res.status(500).json({
            message: "Error running wallet audit",
            error: error.message,
        });
    }
};
