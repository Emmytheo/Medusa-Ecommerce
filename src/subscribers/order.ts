import { type SubscriberConfig, type SubscriberArgs } from "@medusajs/medusa";

import splitParentOrderWorkflow from "../workflows/split-parent-order-workflow";

export default async function orderPlacedHandler({
  data,
  eventName,
  container,
  pluginOptions,
}: SubscriberArgs<Record<string, string>>) {
  // console.log(data);
  splitParentOrderWorkflow(container)
    .run({
      input: {
        id: data.id,
      },
    })
    .then(({ result }) => {
      const logger = container.resolve("logger");
      logger.info(`Workflow completed: ${result.message}`);
    })
    .catch((error) => {
      const logger = container.resolve("logger");
      logger.error("Split Parent Order job failed:", error);
    });
}

export const config: SubscriberConfig = {
  event: "order.placed",
  context: {
    subscriberId: "order-placed-handler",
  },
};
