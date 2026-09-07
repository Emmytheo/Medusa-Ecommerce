import { VendorBankAccount } from "../models/vendor-bank-account";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";

export const VendorBankAccountRepository = dataSource
  .getRepository(VendorBankAccount)
  .extend({
    async findByStoreId(storeId: string): Promise<VendorBankAccount | null> {
      return this.findOne({
        where: { store_id: storeId },
        order: { created_at: "DESC" },
      });
    },

    async findByUserId(userId: string): Promise<VendorBankAccount | null> {
      return this.findOne({
        where: { user_id: userId },
        order: { created_at: "DESC" },
      });
    },
  });

export default VendorBankAccountRepository;
