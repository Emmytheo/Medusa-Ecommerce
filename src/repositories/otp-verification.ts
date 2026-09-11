import { OtpVerification } from "../models/otp-verification";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";
import { MoreThan } from "typeorm";

export const OtpVerificationRepository = dataSource
  .getRepository(OtpVerification)
  .extend({
    async findValidOtp(
      userId: string,
      purpose: string,
      code: string,
      options?: {
        allowRecentlyUsed?: boolean;
        phoneOrEmail?: string;
      }
    ): Promise<OtpVerification | null> {
      const qb = this.createQueryBuilder("otp")
        .where("otp.purpose = :purpose", { purpose })
        .andWhere("otp.code = :code", { code });

      // Target matching: exact user_id, or matching phone suffix/clean ID
      const targetString = (options?.phoneOrEmail || userId || "").toString().trim();
      const digits = targetString.replace(/\D/g, "");
      const lastDigits = digits.length >= 8 ? digits.slice(-9) : null;

      if (lastDigits) {
        qb.andWhere(
          "(otp.user_id = :userId OR otp.user_id LIKE :userPattern OR otp.phone_or_email LIKE :phonePattern)",
          {
            userId,
            userPattern: `%${lastDigits}`,
            phonePattern: `%${lastDigits}`,
          }
        );
      } else {
        qb.andWhere("(otp.user_id = :userId OR otp.phone_or_email = :targetString)", {
          userId,
          targetString,
        });
      }

      // Check finalized state - when not allowing recently used/verified OTPs, ensure not finalized
      if (!options?.allowRecentlyUsed) {
        qb.andWhere(
          "(otp.metadata IS NULL OR (otp.metadata->>'finalized') IS NULL OR otp.metadata->>'finalized' != 'true')"
        );
      }

      const now = new Date();
      if (options?.allowRecentlyUsed) {
        // Allow unexpired unused OTPs OR OTPs verified/used within the last 30 minutes
        const recentlyUsedThreshold = new Date(Date.now() - 30 * 60 * 1000);
        qb.andWhere(
          "((otp.is_used = false AND otp.expires_at > :now) OR (otp.is_used = true AND otp.updated_at > :recentlyUsedThreshold))",
          { now, recentlyUsedThreshold }
        );
      } else {
        qb.andWhere("otp.is_used = false AND otp.expires_at > :now", { now });
      }

      qb.orderBy("otp.created_at", "DESC");

      return await qb.getOne();
    },

    async invalidateUserOtps(userId: string, purpose: string): Promise<void> {
      await this.update(
        { user_id: userId, purpose, is_used: false },
        { is_used: true }
      );
    },
  });

export default OtpVerificationRepository;
