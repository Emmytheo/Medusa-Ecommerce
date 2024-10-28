import { dataSource } from "@medusajs/medusa/dist/loaders/database";
import { OrderRepository as MedusaOrderRepository } from "@medusajs/medusa/dist/repositories/order";
import { Order } from "../models/order";

export const OrderRepository = dataSource
  .getRepository(Order)
  .extend(Object.assign(MedusaOrderRepository, { target: Order }))
  .extend({
    async findParentOrder(orderId: string): Promise<Order | undefined> {
      return this.findOne({ where: { id: orderId, parent_order_id: null } });
    },

    async createChildOrder(
      parentOrderId: string,
      vendorId: string,
      items: any[]
    ): Promise<Order> {
      const childOrder = this.create({
        parent_order_id: parentOrderId,
        vendor_id: vendorId,
        items,
      });
      return this.save(childOrder);
    },
  });

export default OrderRepository;
