import {
  createStep,
  StepResponse,
  createWorkflow,
} from "@medusajs/workflows-sdk";
import { MedusaContainer } from "@medusajs/medusa/dist/types/global";
import { Logger } from "winston";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as nodemailer from "nodemailer";
import EmailTemplates from "email-templates";
import OrderService from "../services/order";
import EventBusService from "@medusajs/medusa/dist/services/event-bus";
import { NotificationService } from "@medusajs/medusa";
import CustomFufillmentManualService from "../services/custom-fufillment-manual";
import FulfillmentRepository from "@medusajs/medusa/dist/repositories/fulfillment";
import { log } from "console";
/**
 * Manage Fulfillments Workflow
 *
 * Input: { tasks: Task[] }
 * Each Task describes an operation to perform against fulfillments and related
 * records in Supabase (pickup_requests, deliveries, etc).
 *
 * The code expects either:
 * - a "supabaseClient" registered in Medusa container, or
 * - SUPABASE_URL and SUPABASE_KEY available in env to create a client.
 *
 * The implementation:
 * - creates pickup_request / delivery rows when requested and links them to the fulfillment
 * - updates fulfillment records for packing / shipping / delivery status updates
 * - emits simple events on the event bus when available
 */

type TaskType =
  | "create_pickup_request"
  | "create_delivery"
  | "update_packing"
  | "confirm_packing"
  | "update_shipping"
  | "update_delivery"
  | "confirm_parent_order";
type Task = {
  type: TaskType;
  fulfillment_id: string;
  data?: Record<string, unknown>;
};

type WorkflowInput = {
  user_id: string;
  payload?: Record<string, unknown>;
  tasks: Task[];
  user?: any;
};

type WorkflowOutput = {
  message: string;
};

async function getSupabaseFromContainerOrEnv(
  container: MedusaContainer
): Promise<SupabaseClient> {
  try {
    // prefer registered client
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const client = container.resolve("supabaseClient") as SupabaseClient;
    if (client) {
      return client;
    }
  } catch {
    // ignore and fallback to env-created client
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase client not registered in container and SUPABASE_URL / SUPABASE_ANON_KEY not set"
    );
  }
  return createClient(url, key);
}

const manageFulfillments = createStep(
  "manageFulfillments",
  async (input: WorkflowInput, context) => {
    const container: MedusaContainer = context.container;
    const logger: Logger = container.resolve("logger");
    const fulfillmentRepo = container.resolve(
      "fulfillmentRepository"
    ) as typeof FulfillmentRepository;
    let eventBusService: EventBusService | null;
    try {
      eventBusService = container.resolve<EventBusService>("eventBusService");
    } catch {
      eventBusService = null;
    }
    const orderService = container.resolve<OrderService>("orderService");
    const orderRepository = container.resolve("orderRepository");
    const notificationService = container.resolve<NotificationService>(
      "notificationService"
    );
    const customFufillmentManualService =
      container.resolve<CustomFufillmentManualService>(
        "customFufillmentManualService"
      );

    const supabase = await getSupabaseFromContainerOrEnv(container);

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const templateMap = {
      "fulfillment.packing.updated": "fulfillmentPackingUpdated",
      "fulfillment.packing.confirmed": "fulfillmentPackingConfirmed",
      "fulfillment.shipping.updated": "fulfillmentShippingUpdated",
      "fulfillment.delivery.updated": "fulfillmentDeliveryUpdated",
      "order.placed": "orderPlaced",
    };

    const sendTemplatedNotification = async (event: string, eventData: any) => {
      const templateName = templateMap[event];
      if (!templateName) return;

      let data = eventData;
      let to = '';

      if (event === 'order.placed') {
        to = eventData.customer.email;
      } else {
        // For fulfillment events, fetch order
        const fulfillment = await fulfillmentRepo.findOne({
          where: { id: eventData.fulfillment_id },
          relations: ['order', 'order.customer']
        });
        data = { ...eventData, fulfillment, order: fulfillment.order, customer: fulfillment.order.customer };
        to = fulfillment.order.customer.email;
      }

      const email = new EmailTemplates({
        message: { from: 'rayvvin01@gmail.com' },
        transport: transporter,
        views: { root: 'data/emailTemplates' },
        send: true
      });
      // console.log("Sending email to:", to, "using template:", templateName, data);

      await email.send({
        template: templateName,
        message: { to },
        locals: { order: data, customer: data.customer, env: process.env }
      });
    };

    logger.info(
      `manageFulfillments received ${input.tasks?.length ?? 0} tasks`
    );

    if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
      return new StepResponse("No tasks to process");
    }

    const results: Array<{ task: Task; success: boolean; detail?: any }> = [];

    for (const task of input.tasks) {
      try {
        switch (task.type) {
          case "create_pickup_request": {
            // expected data: pickup details (address, window, meta...)
            const payload = task.data ?? {};
            const { data: inserted, error } = await supabase
              .from("pickup_requests")
              .insert([
                {
                  fulfillment_id: task.fulfillment_id,
                  payload,
                  created_at: new Date().toISOString(),
                },
              ])
              .select()
              .single();

            if (error) throw error;

            // link to fulfillment record
            await supabase
              .from("fulfillments")
              .update({ pickup_request_id: inserted.id })
              .eq("id", task.fulfillment_id);

            eventBusService?.emit?.("fulfillment.pickup_request.created", {
              fulfillment_id: task.fulfillment_id,
              pickup_request_id: inserted.id,
            });

            results.push({ task, success: true, detail: inserted });
            break;
          }

          case "create_delivery": {
            // expected data: { delivery_id, fulfillment_ids: string[], created_at?, other delivery data }
            console.log("create_delivery task data:", task.data);
            const { delivery_id, fulfillment_ids, created_at, ...otherData } =
              task.data ?? {};
            if (
              !delivery_id ||
              !fulfillment_ids ||
              !Array.isArray(fulfillment_ids)
            ) {
              throw new Error(
                "create_delivery requires delivery_id and fulfillment_ids array"
              );
            }

            const deliveryCreatedAt = created_at || new Date().toISOString();
            const metadataUpdate = {
              delivery_id,
              delivery_created_at: deliveryCreatedAt,
              delivery_confirmed_by: input.user_id,
              delivery_scheduled: true,
              ...otherData,
            };

            const processedFulfillments: string[] = [];
            for (const fulfillmentId of fulfillment_ids) {
              try {
                await customFufillmentManualService.updateFulfillmentMetadata(
                  fulfillmentId,
                  metadataUpdate
                );
                processedFulfillments.push(fulfillmentId);
              } catch (error) {
                logger.error(
                  `Error updating fulfillment metadata for ${fulfillmentId}:`,
                  error
                );
                throw error;
              }
            }

            eventBusService?.emit?.("fulfillment.delivery.scheduled", {
              delivery_id,
              fulfillment_ids: processedFulfillments,
              confirmed_by: input.user_id,
            });

            results.push({
              task,
              success: true,
              detail: { delivery_id, processedFulfillments },
            });
            break;
          }

          case "update_packing": {
            const update = {
              packing_status: task.data?.status ?? null,
              packing_metadata: task.data?.meta ?? null,
              packed_at: task.data?.packed_at ?? null,
            };
            // fetch fulfillment to get order_id and vendor_id
            const { data: fulfillmentRow, error: fulfillmentError } =
              await supabase
                .from("fulfillment")
                .select("*, order:order_id(*)")
                .eq("id", task.fulfillment_id)
                .limit(1)
                .maybeSingle();

            if (fulfillmentError) {
              throw fulfillmentError;
            }

            logger.info(
              `Processing packing update for fulfillment ${task.fulfillment_id}`
            );

            const orderId = fulfillmentRow?.order_id as string | undefined;
            const vendorId =
              fulfillmentRow?.order?.store_id == input.user.store_id
                ? input.user_id
                : null;

            const { data: log_region_data, error: logRegDataError } =
              await supabase
                .from("logistics_org_regions")
                .select(
                  "*, logistics_orgs:logistics_org_id(*), region:region_id(*), fulfillment_provider:fulfillment_provider(*)"
                )
                .eq(
                  "fulfillment_provider",
                  fulfillmentRow?.fulfillment_provider
                )
                .limit(1)
                .maybeSingle();

            if (logRegDataError) {
              throw logRegDataError;
            }

            logger.info(
              `Retrieving Logistic Org Region Data for fulfillment ${task.fulfillment_id}`
            );

            // try to find an existing pickup_request for the vendor that is not processed
            // and that does NOT already contain this order_id or fulfillment_id

            let pickupRequestData: any = null;
            if (vendorId) {
              logger.info(
                `Looking for existing pickup request for vendor ${vendorId}`
              );
              const { data: existingPickup, error: existingPickupError } =
                await supabase
                  .from("pickup_requests")
                  .select("*")
                  .eq("vendor_id", vendorId)
                  // .eq("region_id", log_region_data?.region_id ?? null)
                  // .eq("logistics_org_id", log_region_data?.logistics_org_id ?? null)
                  .neq("status", "processed")
                  .order("created_at", { ascending: true })
                  .limit(1)
                  .maybeSingle();

              if (existingPickupError) {
                throw existingPickupError;
              }

              console.log("Existing Pickup Request:", existingPickup);

              if (existingPickup) {
                // ensure arrays
                const existingOrderIds = Array.isArray(existingPickup.order_ids)
                  ? existingPickup.order_ids.slice()
                  : [];
                const existingFulfillmentIds = Array.isArray(
                  existingPickup.fulfillment_ids
                )
                  ? existingPickup.fulfillment_ids.slice()
                  : [];

                let changed = false;

                if (orderId && !existingOrderIds.includes(orderId)) {
                  existingOrderIds.push(orderId);
                  changed = true;
                }

                if (!existingFulfillmentIds.includes(task.fulfillment_id)) {
                  existingFulfillmentIds.push(task.fulfillment_id);
                  changed = true;
                }

                if (changed) {
                  // persist appended ids
                  const { data: updatedPickup, error: updateError } =
                    await supabase
                      .from("pickup_requests")
                      .update({
                        order_ids: existingOrderIds,
                        fulfillment_ids: existingFulfillmentIds,
                        region_id: log_region_data?.[0].region_id ?? null,
                        logistics_org_id:
                          log_region_data?.[0].logistics_org_id ?? null,
                      })
                      .eq("id", existingPickup.id)
                      .select()
                      .single();

                  if (updateError) {
                    throw updateError;
                  }

                  pickupRequestData = updatedPickup;
                } else {
                  // nothing to change, reuse existing
                  pickupRequestData = existingPickup;
                }
              }
            }

            // if not found, create a new pickup_request and link order_id + fulfillment_id
            if (!pickupRequestData) {
              logger.info(
                `No existing pickup request found, creating new for vendor ${vendorId}`
              );
              const newPickupBody: any = {
                vendor_id: vendorId ?? null,
                order_ids: orderId ? [orderId] : [],
                fulfillment_ids: [task.fulfillment_id],
                // payload: task.data ?? {},
                status: "pending",
                created_at: new Date().toISOString(),
              };

              const { data: insertedPickup, error: insertError } =
                await supabase
                  .from("pickup_requests")
                  .insert([newPickupBody])
                  .select()
                  .single();

              if (insertError) {
                throw insertError;
              }

              pickupRequestData = insertedPickup;
            }

            console.log("Pickup Request Data:", pickupRequestData);
            // ensure the fulfillment metadata update includes the pickup_request reference
            (update as any).pickup_request_id = pickupRequestData?.id ?? null;
            try {
              await customFufillmentManualService.updateFulfillmentMetadata(
                task.fulfillment_id,
                { ...update }
              );
            } catch (error) {
              logger.error(
                `Error updating fulfillment metadata for ${task.fulfillment_id}:`,
                error
              );
              throw error;
            }

            eventBusService?.emit?.("fulfillment.packing.updated", {
              fulfillment_id: task.fulfillment_id,
              update,
            });

            await sendTemplatedNotification("fulfillment.packing.updated", {
              fulfillment_id: task.fulfillment_id,
              update,
            });

            results.push({ task, success: true });
            break;
          }

          case "confirm_packing": {
            const processedAt =
              task.data?.processed_at ?? new Date().toISOString();
            const packagedAt =
              task.data?.packaged_at ?? new Date().toISOString();

            // update fulfillment metadata with pickup_request timestamps
            const metadataUpdate = {
              pickup_request_processed_at: processedAt,
              pickup_request_packaged_at: packagedAt,
            };

            try {
              await customFufillmentManualService.updateFulfillmentMetadata(
                task.fulfillment_id,
                { ...metadataUpdate }
              );
            } catch (error) {
              logger.error(
                `Error updating fulfillment metadata for confirm_packing ${task.fulfillment_id}:`,
                error
              );
              throw error;
            }

            // find associated pickup_request: prefer direct reference on fulfillment, fallback to search by fulfillment_ids
            let pickupRequestId: string | null = null;
            try {
              const { data: fRow, error: fErr } = await supabase
                .from("fulfillment")
                .select("*")
                .eq("id", task.fulfillment_id)
                .maybeSingle();

              if (fErr) throw fErr;

              pickupRequestId = fRow?.metadata?.pickup_request_id ?? null;

              let pickupReqRow: any = null;
              if (pickupRequestId) {
                const { data, error } = await supabase
                  .from("pickup_requests")
                  .select("*")
                  .eq("id", pickupRequestId)
                  .limit(1)
                  .maybeSingle();
                if (error) throw error;
                pickupReqRow = data;
              } else {
                // fallback: find pickup_request that contains this fulfillment_id
                const { data, error } = await supabase
                  .from("pickup_requests")
                  .select("*")
                  .contains("fulfillment_ids", [task.fulfillment_id])
                  .limit(1)
                  .maybeSingle();
                if (error) throw error;
                pickupReqRow = data;
                pickupRequestId = pickupReqRow?.id ?? null;
              }

              if (!pickupRequestId || !pickupReqRow) {
                logger.warn(
                  `No associated pickup_request found for fulfillment ${task.fulfillment_id}`
                );
                // still return success for metadata update
                results.push({
                  task,
                  success: true,
                  detail: "No pickup_request found to update",
                });
                break;
              }

              // prepare order_confirmations entry
              const orderId = fRow?.order_id ?? null;
              const orderConfirmationEntry = {
                order_id: orderId,
                fulfillment_id: task.fulfillment_id,
                packaging_confirmed_at: packagedAt,
                confirmed_by: input.user_id,
              };

              // merge/append into existing order_confirmations (jsonb)
              let updatedOrderConfirmation: any;
              if (Array.isArray(pickupReqRow.order_confirmations)) {
                updatedOrderConfirmation =
                  pickupReqRow.order_confirmations.slice();
                updatedOrderConfirmation.push(orderConfirmationEntry);
              } else if (pickupReqRow.order_confirmations) {
                // if existing is an object, convert to array
                updatedOrderConfirmation = [
                  pickupReqRow.order_confirmations,
                  orderConfirmationEntry,
                ];
              } else {
                updatedOrderConfirmation = [orderConfirmationEntry];
              }

              // update pickup_requests row
              const { data: updatedPickup, error: updatePickupError } =
                await supabase
                  .from("pickup_requests")
                  .update({
                    processed: true,
                    processed_at: processedAt,
                    packaged: true,
                    packaged_at: packagedAt,
                    order_confirmations: updatedOrderConfirmation,
                    status: "processed",
                  })
                  .eq("id", pickupRequestId)
                  .select()
                  .single();

              if (updatePickupError) throw updatePickupError;

              logger.info(
                `Pickup request ${pickupRequestId} updated for fulfillment ${task.fulfillment_id}`
              );

              eventBusService?.emit?.("fulfillment.packing.confirmed", {
                fulfillment_id: task.fulfillment_id,
                pickup_request_id: pickupRequestId,
                processed_at: processedAt,
                packaged_at: packagedAt,
              });

              await sendTemplatedNotification("fulfillment.packing.confirmed", {
                fulfillment_id: task.fulfillment_id,
                pickup_request_id: pickupRequestId,
                processed_at: processedAt,
                packaged_at: packagedAt,
              });

              results.push({ task, success: true, detail: updatedPickup });
            } catch (err) {
              logger.error(
                `Error confirming packing for fulfillment ${task.fulfillment_id}:`,
                err
              );
              results.push({
                task,
                success: false,
                detail: (err as Error).message,
              });
            }

            break;
          }

          case "update_shipping": {
            // console.log("update_shipping", task);
            // expected data: { status, tracking_number?, shipped_at?, carrier?, meta? }
            // const update = {
            //   shipping_status: task.data?.status ?? null,
            //   tracking_number: task.data?.tracking_number ?? null,
            //   carrier: task.data?.carrier ?? null,
            //   shipped_at: task.data?.shipped_at ?? null,
            //   shipping_metadata: task.data?.meta ?? null,
            // };
            // const { error } = await supabase
            //   .from("fulfillment")
            //   .update(update)
            //   .eq("id", task.fulfillment_id);

            // if (error) throw error;

            // Sync with Medusa
            if (task.data?.status === "shipped") {
              try {
                const fulfillment = await fulfillmentRepo.findOne({
                  where: { id: task.fulfillment_id },
                  // select: ["order_id", "shipped_at"],
                });

                // Idempotency check: only create shipment if not already shipped
                if (fulfillment?.order_id && !fulfillment.shipped_at) {
                  const trackingLinks = task.data?.tracking_number
                    ? [{ tracking_number: task.data.tracking_number as string }]
                    : [];

                  const config = {
                    metadata:
                      (task.data?.meta as Record<string, unknown>) ?? {},
                    no_notification: false,
                  };

                  await orderService.createShipment(
                    fulfillment.order_id,
                    task.fulfillment_id,
                    trackingLinks as any,
                    config
                  );
                } else if (fulfillment?.shipped_at) {
                  logger.info(
                    `Fulfillment ${task.fulfillment_id} already shipped, skipping createShipment.`
                  );
                }
              } catch (e) {
                logger.error(
                  `Failed to create shipment in Medusa for ${task.fulfillment_id}:`,
                  e
                );
              }
            }

            eventBusService?.emit?.("fulfillment.shipping.updated", {
              fulfillment_id: task.fulfillment_id,
              // update,
            });

            await sendTemplatedNotification("fulfillment.shipping.updated", {
              fulfillment_id: task.fulfillment_id,
              status: task.data?.status,
            });

            results.push({ task, success: true });
            break;
          }

          case "update_delivery": {
            // expected data: { status, delivered_at?, proof?, meta? }
            const status = task.data?.status as string | null;
            const meta = (task.data?.meta as Record<string, unknown>) || {};
            const proof = task.data?.proof ?? null;

            // Auto-populate timestamps in metadata based on status
            if (status) {
              const now = new Date().toISOString();
              // map status to timestamp field
              if (status === "processing") {
                meta.processed_at =
                  task.data?.processed_at ?? meta.processed_at ?? now;
              } else if (status === "delivered") {
                meta.delivered_at =
                  task.data?.delivered_at ?? meta.delivered_at ?? now;
              } else if (status === "completed") {
                meta.completed_at =
                  task.data?.completed_at ?? meta.completed_at ?? now;
              }
            }

            const update = {
              status: status,
              // proof: proof,
              metadata: meta,
            };

            const { error } = await supabase
              .from("deliveries")
              .update(update)
              .eq("id", task.data?.delivery_id);

            if (error) throw error;

            // Sync metadata with Medusa (handles parent/child sync)
            try {
              const metadataUpdate = {
                delivery_status: status,
                // delivery_proof: proof,
                ...meta,
              };

              await customFufillmentManualService.updateFulfillmentMetadata(
                task.fulfillment_id,
                metadataUpdate
              );
            } catch (e) {
              logger.error(
                `Failed to sync delivery metadata in Medusa for ${task.fulfillment_id}:`,
                e
              );
            }

            eventBusService?.emit?.("fulfillment.delivery.updated", {
              fulfillment_id: task.fulfillment_id,
              update,
            });

            await sendTemplatedNotification("fulfillment.delivery.updated", {
              fulfillment_id: task.fulfillment_id,
              status,
              delivered_at: meta.delivered_at,
            });

            // Optionally capture or finalize related order/payment if business requires
            try {
              // attempt to retrieve fulfillment to know order_id (if stored)
              const { data: fRows } = await supabase
                .from("fulfillment") // Used to be fulfillments, user changed to fulfillment in step 43?
                // Wait, checking step 43, user changed fulfillments -> fulfillment.
                // But earlier in step 42 user changed fulfillments -> deliveries for the UPDATE.
                // Here we are selecting from 'fulfillment' (singular) likely valid if user changed schema/naming.
                // I should stick to 'fulfillment' here if that's what is in the file.
                // Let's check the current file content for the select.
                .select("order_id")
                .eq("id", task.fulfillment_id)
                .maybeSingle();

              if (fRows?.order_id) {
                eventBusService?.emit?.("order.fulfillment.delivered", {
                  order_id: fRows.order_id,
                  fulfillment_id: task.fulfillment_id,
                });
              }
            } catch {
              // ignore non-critical post processing
            }

            results.push({ task, success: true });
            break;
          }

          case "confirm_parent_order": {
            // expected data: { parent_order_id }
            const parentOrderId = task.data?.parent_order_id as string;
            if (!parentOrderId) {
              throw new Error("confirm_parent_order requires parent_order_id");
            }

            try {
              // Check if parent order has child orders
              const { data: orderData, error: orderError } = await supabase
                .from("order")
                .select("metadata, draft_order_id")
                .eq("id", parentOrderId)
                .single();

              if (orderError) throw orderError;

              const metadata = orderData?.metadata || {};
              const isParentOrder =
                (!metadata || Object.keys(metadata).length === 0) &&
                !orderData?.draft_order_id;

              // Check if parent order already has child orders
              const childOrders = await orderRepository.find({
                where: {
                  metadata: {
                    parent: parentOrderId,
                    type: "childOrder",
                  },
                },
              });

              // Always retrieve order details and send notification
              try {
                const order = await orderRepository.findOne({
                  where: { id: parentOrderId },
                  relations: [
                    "items",
                    "items.variant",
                    "cart",
                    "shipping_methods",
                    "payments",
                    "customer", 
                  ],
                });

                // console.log("Order for notification:", order);

                const providerId = "smtp";

                logger.info(
                  `Sending order confirmation email to customer ${order.customer.email} for order ${order.id}`
                );

                await sendTemplatedNotification("order.placed", order);

                logger.info(
                  `Successfully sent order confirmation email to ${order.customer.email}`
                );

                //admin copy
                logger.info(
                  `Sending admin copy of order confirmation email for order ${order.id}`
                );

                // For admin, we need to send directly since sendTemplatedNotification expects fulfillment events for non-order.placed
                await transporter.sendMail({
                  from: "rayvvin01@gmail.com",
                  to: "rayvvin01@gmail.com",
                  subject: "Order Confirmation - Admin Copy",
                  html: `<h1>Order Placed</h1><p>Order ${order.id} has been placed by customer ${order.customer.email}.</p>`,
                });

                logger.info(
                  `Successfully sent admin copy of order confirmation email to rayvvin01@gmail.com`
                );
              } catch (notificationError) {
                logger.error(
                  `Error sending notification for order ${parentOrderId}:`,
                  notificationError
                );
                // Don't throw, as the order confirmation succeeded
              }

              // Only emit event if no child orders exist
              if (!childOrders || childOrders.length === 0) {
                eventBusService?.emit?.("order.placed", {
                  id: parentOrderId,
                  confirmed_at: new Date().toISOString(),
                });

                results.push({
                  task,
                  success: true,
                  detail: `Parent order ${parentOrderId} confirmed and order.placed event emitted`,
                });
              } else {
                results.push({
                  task,
                  success: true,
                  detail: `Parent order ${parentOrderId} has child orders, skipping confirmation`,
                });
              }
            } catch (error) {
              logger.error(
                `Error confirming parent order ${parentOrderId}:`,
                error
              );
              throw error;
            }
            break;
          }

          default: {
            logger.warn(`Unknown task type: ${task.type}`);
            results.push({
              task,
              success: false,
              detail: `Unknown task type: ${task.type}`,
            });
            break;
          }
        }
      } catch (err) {
        logger.error(
          `Error processing fulfillment task ${task.type} for ${task.fulfillment_id}:`,
          err
        );
        results.push({ task, success: false, detail: (err as Error).message });
      }
    }

    // Optionally: update a summary table or emit a final event
    eventBusService?.emit?.("fulfillments.tasks.processed", {
      count: results.length,
      results,
    });

    return new StepResponse(`Processed ${results.length} fulfillment tasks`);
  }
);

const manageFulfillmentsWorkflow = createWorkflow<
  WorkflowInput,
  WorkflowOutput
>("manage-fulfillments-workflow", function (input) {
  const message = manageFulfillments(input);
  return {
    message,
  };
});

export default manageFulfillmentsWorkflow;
