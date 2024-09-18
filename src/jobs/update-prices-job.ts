import {
  type ScheduledJobConfig,
  type ScheduledJobArgs,
} from "@medusajs/medusa";
import updatePricesWorkflow from "../workflows/update-prices-workflow";

export default async function handler({
  container,
  data,
  pluginOptions,
}: ScheduledJobArgs) {
  updatePricesWorkflow(container)
    .run()
    .then(({ result }) => {
      const logger = container.resolve("logger");
      logger.info(`Workflow completed: ${result.message}`);
    })
    .catch((error) => {
      const logger = container.resolve("logger");
      logger.error("Update prices job failed:", error);
    });
}

export const config: ScheduledJobConfig = {
  name: "update-prices-job",
  schedule: "0 0 * * 1", // Every Monday at 00:00
  // schedule: "* * * * *",
  data: {},
};
