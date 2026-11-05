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
        /** If true, skip the code match — used by sendOtp for idempotency checks. */
        skipCodeCheck?: boolean;
      }
    ): Promise<OtpVerification | null> {
      const qb = this.createQueryBuilder("otp")
        .where("otp.purpose = :purpose", { purpose });

      // Only filter by code when we actually have one to match
      if (!options?.skipCodeCheck && code) {
        qb.andWhere("otp.code = :code", { code });
      }

      // Target matching: exact user_id, or matching phone suffix/clean ID
      const targetString = (options?.phoneOrEmail || userId || "").toString().trim();
      const digits = targetString.replace(/\D/g, "");

      // Extract Nigerian national core (10 digits without leading 0 or 234)
      let coreDigits = digits;
      if (coreDigits.startsWith("234") && coreDigits.length >= 13) {
        coreDigits = coreDigits.slice(3);
      } else if (coreDigits.startsWith("0") && coreDigits.length >= 11) {
        coreDigits = coreDigits.slice(1);
      }
      // If extra trailing digits exist (e.g. 11+ digits), extract the primary 10-digit national number
      const primaryCore = coreDigits.length >= 10 ? coreDigits.slice(0, 10) : coreDigits;
      const lastDigits = digits.length >= 8 ? digits.slice(-9) : null;

      if (lastDigits || primaryCore.length >= 8) {
        const patterns: Record<string, string> = { userId };
        let patternSql = "otp.user_id = :userId";

        if (lastDigits) {
          patterns.userPattern = `%${lastDigits}`;
          patterns.phonePattern = `%${lastDigits}`;
          patternSql += " OR otp.user_id LIKE :userPattern OR otp.phone_or_email LIKE :phonePattern";
        }
        if (primaryCore.length >= 8) {
          patterns.corePattern = `%${primaryCore}%`;
          patternSql += " OR otp.user_id LIKE :corePattern OR otp.phone_or_email LIKE :corePattern";
        }

        qb.andWhere(`(${patternSql})`, patterns);
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

      let otpRecord = await qb.getOne();
      if (otpRecord) {
        return otpRecord;
      }

      // ── Secondary Resilience Fallback ──
      // If code was provided, look for any active unexpired OTP for this purpose
      // whose phone/user_id shares the core digits with the submitted target.
      if (!options?.skipCodeCheck && code && primaryCore.length >= 8) {
        const fallbackQb = this.createQueryBuilder("otp")
          .where("otp.purpose = :purpose", { purpose })
          .andWhere("otp.code = :code", { code });

        if (!options?.allowRecentlyUsed) {
          fallbackQb.andWhere(
            "(otp.metadata IS NULL OR (otp.metadata->>'finalized') IS NULL OR otp.metadata->>'finalized' != 'true')"
          );
          fallbackQb.andWhere("otp.is_used = false AND otp.expires_at > :now", { now });
        } else {
          const recentlyUsedThreshold = new Date(Date.now() - 30 * 60 * 1000);
          fallbackQb.andWhere(
            "((otp.is_used = false AND otp.expires_at > :now) OR (otp.is_used = true AND otp.updated_at > :recentlyUsedThreshold))",
            { now, recentlyUsedThreshold }
          );
        }

        fallbackQb.orderBy("otp.created_at", "DESC");
        const candidates = await fallbackQb.getMany();

        for (const candidate of candidates) {
          const candDigits = (candidate.phone_or_email || candidate.user_id || "").replace(/\D/g, "");
          if (
            candDigits.includes(primaryCore) ||
            primaryCore.includes(candDigits.slice(-8)) ||
            candDigits.includes(primaryCore.slice(0, 8))
          ) {
            return candidate;
          }
        }
      }

      return null;
    },

    async invalidateUserOtps(userId: string, purpose: string): Promise<void> {
      await this.update(
        { user_id: userId, purpose, is_used: false },
        { is_used: true }
      );
    },
  });

export default OtpVerificationRepository;
