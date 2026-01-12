import { wrapHandler } from "@medusajs/utils";
import { Router } from "express";
// import getOnboardingStatus from "./get-status";
// import updateOnboardingStatus from "./update-status";
import { POST as manageFulfillmentsHandler } from "./route";

const router = Router();

export default (adminRouter: Router) => {
    //   adminRouter.use("/custom/manage", router);
    adminRouter.use("/manage-fulfillments", router);
    router.post("/", wrapHandler(manageFulfillmentsHandler));

};
