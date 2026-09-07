import { VendorPayout } from "../models/vendor-payout";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";

export const VendorPayoutRepository = dataSource
  .getRepository(VendorPayout)
  .extend({
    async listByStoreId(storeId: string, limit: number = 50, offset: number = 0): Promise<[VendorPayout[], number]> {
      return this.findAndCount({
        where: { store_id: storeId },
        order: { created_at: "DESC" },
        take: limit,
        skip: offset,
      });
    },

    async listByUserId(userId: string, limit: number = 50, offset: number = 0): Promise<[VendorPayout[], number]> {
      return this.findAndCount({
        where: { user_id: userId },
        order: { created_at: "DESC" },
        take: limit,
        skip: offset,
      });
    },
  });

export default VendorPayoutRepository;
