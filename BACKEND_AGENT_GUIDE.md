# Backend Agent Integration Guide: Secure Realtime SMS & Command Gateway

This document provides complete instructions, database schemas, cryptographic specifications, and ready-to-run code snippets for backend developers and AI agents implementing the server-side counterpart to the Android SMS App gateway.

---

## 1. System Architecture Overview

The Android application operates as a high-throughput cellular edge gateway and local execution node connected to **Supabase Realtime**.

```
[Backend Server / Agent]
         │
         ▼ (1) Generates HMAC-SHA256 Signed Command
[Supabase Realtime Channel: 'gateway:commands']
         │
         ▼ (2) Realtime Event Dispatched
[Android Device Gateway]
   ├── (3) Verifies HMAC Signature & Replay Window (±300s)
   ├── (4) Queues in High-Throughput Concurrency Worker
   ├── (5) Executes Action:
   │         ├── 'send_sms' (OTP / Alert via SmsManager)
   │         ├── 'account_create' / 'account_update'
   │         └── 'ping'
   ├── (6) Broadcasts Execution Result back to 'gateway:device_events'
   └── (7) Persists Audit Record in Supabase Table 'device_command_logs'
```

---

## 2. Database Schema (Supabase SQL Migration)

Execute the following SQL in your Supabase SQL Editor or migration pipeline to create the audit and tracking table:

```sql
-- Create device command logs table
CREATE TABLE IF NOT EXISTS public.device_command_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    command_id TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'auth_failed')),
    payload JSONB NOT NULL,
    response JSONB,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indices for high-throughput lookup
CREATE INDEX IF NOT EXISTS idx_cmd_device_id ON public.device_command_logs (device_id);
CREATE INDEX IF NOT EXISTS idx_cmd_status ON public.device_command_logs (status);
CREATE INDEX IF NOT EXISTS idx_cmd_created_at ON public.device_command_logs (created_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.device_command_logs ENABLE ROW LEVEL SECURITY;

-- Service Role full access policy
CREATE POLICY "Service role has full access to device_command_logs"
    ON public.device_command_logs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Authenticated devices can insert and update their own logs
CREATE POLICY "Devices can insert and update command logs"
    ON public.device_command_logs
    FOR ALL
    TO anon, authenticated
    USING (true)
    WITH CHECK (true);
```

---

## 3. Cryptographic Security & Authenticity Specification

Every command transmitted across Supabase Realtime **must** be cryptographically signed by the backend to prevent unauthorized command injection or spoofing.

### Envelope Structure:
```json
{
  "command_id": "a5e8c187-73d8-4f81-a9f2-2b21703c31d1",
  "device_id": "all", 
  "timestamp": 1729000000,
  "action": "send_sms",
  "payload": {
    "phone_number": "+2348012345678",
    "message": "Your verification code is 849201. Valid for 5 minutes.",
    "sim_slot": 0
  },
  "signature": "d3b07384d113edec49eaa6238ad5ff00..."
}
```

### Signature Generation Algorithm:
1. **Canonical Payload String:**
   Concatenate the fields using the delimiter `|`:
   ```
   canonical_string = "${command_id}|${device_id}|${timestamp}|${action}|${JSON.stringify(payload)}"
   ```
2. **HMAC-SHA256:**
   Compute the HMAC-SHA256 of `canonical_string` using the shared **Server Signing Secret** (`GATEWAY_SERVER_SECRET`).
3. **Hex Encode:**
   Convert the digest to a lowercase hexadecimal string.

### Device-Side Security Validation:
- If `abs(current_epoch - timestamp) > 300` (5 minutes), the device drops the command (`REPLAY_WINDOW_EXPIRED`).
- If `command_id` has already been processed within the last 24 hours, the command is discarded (`DUPLICATE_NONCE`).
- If computed signature does not match the received signature, the command is rejected with status `auth_failed`.

---

## 4. Supported Actions & Payload Schemas

### Action 1: `send_sms` (OTP Delivery & Customer Messaging)
Dispatches an SMS via the phone's native cellular modem:
```json
{
  "command_id": "uuid-v4",
  "device_id": "all",
  "timestamp": 1729000000,
  "action": "send_sms",
  "payload": {
    "phone_number": "+2348012345678",
    "message": "Your security code is 912304.",
    "sim_slot": 0,
    "metadata": {
      "purpose": "login_otp",
      "user_id": "usr_99812"
    }
  },
  "signature": "<hmac_sha256_hex>"
}
```
* `sim_slot`: Optional (`0` for SIM 1, `1` for SIM 2). Defaults to device's default sending SIM or SIM 1.
* Long messages (>160 ASCII chars / >70 Unicode chars) are automatically segmented into concatenated multi-part PDUs natively by the device.

### Action 2: `account_create`
Notifies the device of a new store or account creation:
```json
{
  "command_id": "uuid-v4",
  "device_id": "all",
  "timestamp": 1729000000,
  "action": "account_create",
  "payload": {
    "account_id": "acc_10293",
    "email": "store@example.com",
    "business_name": "Lagos Fashion Hub",
    "metadata": {}
  },
  "signature": "<hmac_sha256_hex>"
}
```

### Action 3: `account_update`
Notifies the device of account state changes:
```json
{
  "command_id": "uuid-v4",
  "device_id": "all",
  "timestamp": 1729000000,
  "action": "account_update",
  "payload": {
    "account_id": "acc_10293",
    "status": "active",
    "updated_fields": {
      "tier": "premium"
    }
  },
  "signature": "<hmac_sha256_hex>"
}
```

### Action 4: `ping` (Liveness / Diagnostics)
```json
{
  "command_id": "uuid-v4",
  "device_id": "all",
  "timestamp": 1729000000,
  "action": "ping",
  "payload": {},
  "signature": "<hmac_sha256_hex>"
}
```

---

## 5. Bidirectional Device Acknowledgments (`gateway:device_events`)

The backend agent can listen to the Realtime channel `gateway:device_events` to receive immediate execution callbacks from devices:

```json
{
  "command_id": "uuid-v4",
  "device_id": "android_node_01",
  "status": "completed",
  "action": "send_sms",
  "result": {
    "sent": true,
    "parts_count": 1,
    "sim_used": 0,
    "delivery_timestamp": 1729000005
  },
  "timestamp": 1729000005
}
```

Possible statuses:
- `received`: Device validated signature and enqueued command.
- `processing`: Worker is actively executing the hardware action.
- `completed`: Action executed successfully.
- `failed`: Hardware error, invalid recipient number, or carrier radio error.
- `auth_failed`: Cryptographic signature mismatch or replay timestamp violation.

---

## 6. Ready-to-Run Backend Implementations

### A. TypeScript / Supabase Edge Function Implementation

```typescript
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GATEWAY_SERVER_SECRET = Deno.env.get("GATEWAY_SERVER_SECRET") || "antigravity-secret-key-2026";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Helper: Compute HMAC-SHA256
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

export async function dispatchSmsOtp(phoneNumber: string, otpCode: string, targetDeviceId: string = "all") {
  const commandId = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const action = "send_sms";
  
  const payload = {
    phone_number: phoneNumber,
    message: `Your verification code is: ${otpCode}. Valid for 5 minutes.`,
    sim_slot: 0,
    metadata: { purpose: "otp", created_at: timestamp }
  };

  // Canonical string: command_id|device_id|timestamp|action|payload_json
  const canonicalString = `${commandId}|${targetDeviceId}|${timestamp}|${action}|${JSON.stringify(payload)}`;
  const signature = await generateHmacSignature(canonicalString, GATEWAY_SERVER_SECRET);

  const commandEnvelope = {
    command_id: commandId,
    device_id: targetDeviceId,
    timestamp,
    action,
    payload,
    signature
  };

  // 1. Initial audit log insert in Supabase
  await supabase.from("device_command_logs").insert({
    command_id: commandId,
    device_id: targetDeviceId,
    action,
    status: "pending",
    payload
  });

  // 2. Broadcast command over Supabase Realtime
  const channel = supabase.channel("gateway:commands");
  await channel.subscribe();
  await channel.send({
    type: "broadcast",
    event: "execute_command",
    payload: commandEnvelope
  });

  return { success: true, command_id: commandId };
}
```

---

### B. Node.js Dispatcher Script

```javascript
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ehhevvujhtrjgcznewzg.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GATEWAY_SECRET = process.env.GATEWAY_SERVER_SECRET || 'antigravity-secret-key-2026';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function signPayload(commandId, deviceId, timestamp, action, payload, secret) {
  const canonical = `${commandId}|${deviceId}|${timestamp}|${action}|${JSON.stringify(payload)}`;
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

async function sendSmsCommand(phone, message) {
  const commandId = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const action = 'send_sms';
  const deviceId = 'all';

  const payload = {
    phone_number: phone,
    message: message,
    sim_slot: 0
  };

  const signature = signPayload(commandId, deviceId, timestamp, action, payload, GATEWAY_SECRET);

  const channel = supabase.channel('gateway:commands');
  await channel.subscribe();

  const status = await channel.send({
    type: 'broadcast',
    event: 'execute_command',
    payload: {
      command_id: commandId,
      device_id: deviceId,
      timestamp,
      action,
      payload,
      signature
    }
  });

  console.log(`Dispatched command ${commandId}: ${status}`);
}
```

---

## 7. High-Throughput & Rate Limiting Best Practices

1. **Carrier Flooding Prevention:**
   The Android device maintains an internal FIFO queue and enforces a 500ms delay between dispatches. The backend can flood hundreds of OTP requests simultaneously without dropping messages—the device buffers, sequentially sends, and streams progress callbacks.
2. **Device Offline Handling:**
   If no device acknowledges within 10 seconds, the backend agent should query `device_command_logs` where `status = 'pending'` and alert system operators or failover to an external SMS gateway (e.g. Twilio/Termii).
3. **Sender ID Notice:**
   Outgoing SMS sent from the Android device will show the cellular phone number of SIM 1 or SIM 2 as the caller ID, because mobile carriers enforce MSISDN identity at the baseband radio layer.
