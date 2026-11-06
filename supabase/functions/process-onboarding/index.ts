// Supabase Edge Function: process-onboarding
// Intercepts vendor onboarding requests from the Android SMS Gateway / Webhook
// Provisions vendor accounts and dispatches welcome credentials via SMS.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://ehhevvujhtrjgcznewzg.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const MEDUSA_URL = Deno.env.get("MEDUSA_URL") || "http://107.22.112.205:9000";
const GATEWAY_SERVER_SECRET = Deno.env.get("GATEWAY_SERVER_SECRET") || "antigravity-secret-key-2026";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Helper: Compute HMAC-SHA256 for direct device gateway dispatch fallback
async function generateHmacSignature(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let body: Record<string, any> = {};
    const text = await req.text();
    if (text && text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch (_) {
        body = { raw_body: text };
      }
    }

    console.log("[process-onboarding] Received payload:", JSON.stringify(body));

    // Normalize vendor fields
    const rawBody = body.raw_body || body.message || text || "";
    let phone = (body.phone || body.phone_number || body.sender || body.sender_phone || "").toString().trim();

    // If phone missing, extract Nigerian format from raw text
    if (!phone && rawBody) {
      const match = rawBody.match(/(?:\+?234|0)[789][01]\d{8}/);
      if (match) phone = match[0];
    }

    let cleanPhone = phone.replace(/\D/g, "");
    if (cleanPhone.startsWith("0") && cleanPhone.length === 11) {
      cleanPhone = "234" + cleanPhone.slice(1);
    }
    if (cleanPhone.startsWith("234") && !phone.startsWith("+")) {
      phone = "+" + cleanPhone;
    } else if (cleanPhone && !phone.startsWith("+")) {
      phone = "+" + cleanPhone;
    }

    const businessName = (
      body.business_name ||
      body.businessName ||
      body.store_name ||
      body.storeName ||
      (body.name && !/^\+?\d+$/.test(body.name) ? `${body.name}'s Store` : "AFM Store")
    ).toString().trim();

    const contactName = (
      body.contact_name ||
      body.name ||
      "Vendor"
    ).toString().trim();

    const storeType = (
      body.type ||
      body.store_type ||
      body.storeType ||
      body.niche ||
      "general"
    ).toString().trim();

    const address = (body.address || "").toString().trim();
    const products = Array.isArray(body.products) ? body.products : [];

    // 1. Audit log into Supabase onboarding_requests table
    let recordId = crypto.randomUUID();
    try {
      const { data: inserted, error: insertErr } = await supabase
        .from("onboarding_requests")
        .insert({
          id: recordId,
          phone: phone || null,
          sender: body.sender || phone || null,
          name: contactName,
          business_name: businessName,
          store_type: storeType,
          address: address,
          products: products,
          raw_body: rawBody,
          status: "processing",
        })
        .select()
        .maybeSingle();

      if (inserted?.id) {
        recordId = inserted.id;
      }
      if (insertErr) {
        console.warn("[process-onboarding] Table insert warning:", insertErr.message);
      }
    } catch (e: any) {
      console.warn("[process-onboarding] Supabase insert failed:", e.message);
    }

    // 2. Call Medusa Backend to provision vendor account
    let medusaSuccess = false;
    let medusaData: any = null;

    try {
      const medusaRes = await fetch(`${MEDUSA_URL}/admin/vendor/onboarding/sms-onboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: phone,
          sender: body.sender || phone,
          name: contactName,
          business_name: businessName,
          store_type: storeType,
          address: address,
          products: products,
          raw_body: rawBody,
        }),
      });

      if (medusaRes.ok) {
        medusaData = await medusaRes.json();
        medusaSuccess = true;
        console.log("[process-onboarding] Medusa provisioned vendor:", medusaData);
      } else {
        const errText = await medusaRes.text();
        console.warn(`[process-onboarding] Medusa returned HTTP ${medusaRes.status}:`, errText);
      }
    } catch (err: any) {
      console.warn("[process-onboarding] Failed to reach Medusa backend:", err.message);
    }

    // 3. Fallback: If Medusa was unreachable, dispatch confirmation SMS directly via Realtime
    if (!medusaSuccess && phone) {
      console.log("[process-onboarding] Executing direct Edge confirmation dispatch fallback...");
      const commandId = crypto.randomUUID();
      const timestamp = Math.floor(Date.now() / 1000);
      const action = "send_sms";
      const targetDeviceId = "all";

      const welcomeSms = `Welcome to Afriomarkets! We received your onboarding request for '${businessName}'. Your vendor portal access is being set up. [Official SMS Onboarding]`;

      const payload = {
        phone_number: phone,
        message: welcomeSms,
        sim_slot: 0,
        metadata: { purpose: "onboarding_acknowledgment", created_at: timestamp },
      };

      const canonicalString = `${commandId}|${targetDeviceId}|${timestamp}|${action}|${JSON.stringify(payload)}`;
      const signature = await generateHmacSignature(canonicalString, GATEWAY_SERVER_SECRET);

      const commandEnvelope = {
        command_id: commandId,
        device_id: targetDeviceId,
        timestamp,
        action,
        payload,
        signature,
      };

      try {
        await supabase.from("device_command_logs").insert({
          command_id: commandId,
          device_id: targetDeviceId,
          action,
          status: "pending",
          payload,
        });

        const channel = supabase.channel("gateway:commands");
        await channel.subscribe();
        await channel.send({
          type: "broadcast",
          event: "execute_command",
          payload: commandEnvelope,
        });
        console.log(`[process-onboarding] Dispatched fallback SMS command ${commandId}`);
      } catch (dispatchErr: any) {
        console.error("[process-onboarding] Realtime command dispatch failed:", dispatchErr.message);
      }
    }

    // 4. Update status in onboarding_requests
    try {
      await supabase
        .from("onboarding_requests")
        .update({
          status: medusaSuccess ? "completed" : "pending_provisioning",
          medusa_user_id: medusaData?.vendor?.user_id || null,
          medusa_store_id: medusaData?.vendor?.store_id || null,
          temporary_password: medusaData?.vendor?.temporary_password || null,
          response_payload: medusaData || { queued_on_edge: true },
          updated_at: new Date().toISOString(),
        })
        .eq("id", recordId);
    } catch (_) {}

    return new Response(
      JSON.stringify({
        success: true,
        message: "Vendor onboarding processed successfully.",
        request_id: recordId,
        vendor: medusaData?.vendor || {
          phone,
          business_name: businessName,
          status: medusaSuccess ? "active" : "pending_provisioning",
        },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("[process-onboarding] Top-level error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
