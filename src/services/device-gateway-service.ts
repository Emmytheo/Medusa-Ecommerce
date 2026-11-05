import { TransactionBaseService } from "@medusajs/medusa";
import { Logger } from "winston";
import { Service } from "typedi";
import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import crypto from "crypto";

export interface SendGatewaySmsResult {
  success: boolean;
  messageId?: string;
  commandId?: string;
  error?: string;
  deviceId?: string;
}

export interface GatewayCommandLog {
  id: string;
  command_id: string;
  device_id: string;
  action: string;
  status: "pending" | "processing" | "completed" | "failed" | "auth_failed";
  payload: Record<string, any>;
  response?: Record<string, any> | null;
  error_message?: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singleton — ONE Supabase client + ONE set of Realtime channels
// shared across ALL DeviceGatewayService instances (Medusa creates a new
// instance per request scope, which was causing 100s of concurrent Supabase
// WebSocket connections → Realtime quota exceeded → CHANNEL_ERROR → no SMS).
// ─────────────────────────────────────────────────────────────────────────────
let _sharedClient: SupabaseClient | null = null;
let _commandChannel: RealtimeChannel | null = null;
let _eventsChannel: RealtimeChannel | null = null;
let _onboardingChannel: RealtimeChannel | null = null;
let _commandChannelReady: boolean = false;
let _commandChannelInitPromise: Promise<void> | null = null;
let _watchdogTimer: NodeJS.Timeout | null = null;
let _isReconnecting: boolean = false;
let _pingCounter: number = 0;
const _activeDevices: Map<string, { lastSeen: number; metadata?: any }> = new Map();
const _pendingResolvers: Map<
  string,
  (res: { status: string; result?: any; error?: string }) => void
> = new Map();

function safeTeardownChannel(channel: RealtimeChannel | null): void {
  if (!channel) return;
  try {
    if (_sharedClient) {
      _sharedClient.removeChannel(channel).catch(() => {});
    }
  } catch (_) {}
}

function getSharedSupabaseClient(logger: any): SupabaseClient | null {
  if (_sharedClient) return _sharedClient;

  const supabaseUrl =
    process.env.SUPABASE_URL || "https://ehhevvujhtrjgcznewzg.supabase.co";
  // Prefer ANON key for Realtime WebSocket channel consistency with Flutter gateway app
  const supabaseKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.STORAGE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    logger.warn(
      "[DeviceGatewayService] Supabase URL or Key is missing in environment."
    );
    return null;
  }

  try {
    _sharedClient = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      realtime: {
        heartbeatIntervalMs: 15000, // Frequent WebSocket heartbeats (15s) prevent idle NAT/proxy drops
        timeout: 10000,
        params: {
          eventsPerSecond: 20,
        },
      },
    });

    // Establish channels and start permanent watchdog
    setupSharedRealtimeChannels(logger);
    startRealtimeWatchdog(logger);
  } catch (err: any) {
    logger.error(
      `[DeviceGatewayService] Failed to initialize Supabase client: ${err.message}`
    );
  }

  return _sharedClient;
}

function ensureSharedCommandChannel(logger: any): Promise<void> {
  if (
    _commandChannelReady &&
    _commandChannel &&
    (_commandChannel as any).state === "joined"
  ) {
    return Promise.resolve();
  }
  if (_commandChannelInitPromise) {
    return _commandChannelInitPromise;
  }

  _commandChannelInitPromise = new Promise<void>((resolve) => {
    if (!_sharedClient) {
      return resolve();
    }

    if (!_commandChannel) {
      _commandChannel = _sharedClient.channel("gateway:commands");
    }

    const timer = setTimeout(() => {
      logger.warn(
        "[DeviceGatewayService] Command channel subscribe timed out — proceeding anyway."
      );
      resolve();
    }, 5000);

    _commandChannel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        _commandChannelReady = true;
        clearTimeout(timer);
        logger.info(
          "[DeviceGatewayService] Subscribed to Realtime channel 'gateway:commands'"
        );
        resolve();
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        logger.warn(
          `[DeviceGatewayService] Command channel status: ${status}${err ? ` (${err.message})` : ""}. Monitored by watchdog.`
        );
        clearTimeout(timer);
        _commandChannelReady = false;
        _commandChannelInitPromise = null;
        resolve();
      }
    });
  });

  return _commandChannelInitPromise;
}

function setupEventsChannel(logger: any): void {
  if (!_sharedClient) return;
  if (_eventsChannel && (_eventsChannel as any).state === "joined") return;

  try {
    if (_eventsChannel) {
      safeTeardownChannel(_eventsChannel);
      _eventsChannel = null;
    }

    _eventsChannel = _sharedClient.channel("gateway:device_events");
    _eventsChannel
      .on("broadcast", { event: "command_ack" }, (payload: any) => {
        handleSharedDeviceEvent(payload?.payload, logger);
      })
      .on("broadcast", { event: "command_result" }, (payload: any) => {
        handleSharedDeviceEvent(payload?.payload, logger);
      })
      .on("broadcast", { event: "heartbeat" }, (payload: any) => {
        handleSharedHeartbeat(payload?.payload, logger);
      })
      .on("broadcast", { event: "device_heartbeat" }, (payload: any) => {
        handleSharedHeartbeat(payload?.payload, logger);
      })
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          logger.info(
            "[DeviceGatewayService] Subscribed to Realtime channel 'gateway:device_events'"
          );
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          logger.warn(
            `[DeviceGatewayService] Events channel status: ${status}${err ? ` (${err.message})` : ""}.`
          );
        }
      });
  } catch (err: any) {
    logger.warn(
      `[DeviceGatewayService] Events channel setup warning: ${err.message}`
    );
  }
}

function setupOnboardingChannel(logger: any): void {
  if (!_sharedClient) return;
  if (_onboardingChannel && (_onboardingChannel as any).state === "joined") return;

  try {
    if (_onboardingChannel) {
      safeTeardownChannel(_onboardingChannel);
      _onboardingChannel = null;
    }

    _onboardingChannel = _sharedClient.channel("gateway:onboarding_sync");
    _onboardingChannel
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "onboarding_requests" },
        async (payload: any) => {
          const row = payload?.new;
          if (row && (row.status === "pending" || row.status === "processing")) {
            logger.info(
              `[DeviceGatewayService] Realtime sync: intercepted new onboarding request ${row.id} for ${row.phone || row.sender}`
            );
            try {
              await fetch(
                "http://localhost:9000/admin/vendor/onboarding/sms-onboard",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(row),
                }
              );
            } catch (err: any) {
              logger.warn(
                `[DeviceGatewayService] Failed to auto-provision onboarding request: ${err.message}`
              );
            }
          }
        }
      )
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          logger.info(
            "[DeviceGatewayService] Subscribed to Realtime channel 'gateway:onboarding_sync'"
          );
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          logger.warn(
            `[DeviceGatewayService] Onboarding sync channel status: ${status}${err ? ` (${err.message})` : ""}.`
          );
        }
      });
  } catch (err: any) {
    logger.warn(
      `[DeviceGatewayService] Onboarding sync channel setup warning: ${err.message}`
    );
  }
}

function setupSharedRealtimeChannels(logger: any): void {
  ensureSharedCommandChannel(logger);
  setupEventsChannel(logger);
  setupOnboardingChannel(logger);
}

function startRealtimeWatchdog(logger: any): void {
  if (_watchdogTimer) return;

  logger.info(
    "[DeviceGatewayService] 🛡️ Starting Realtime Watchdog (15s health check, 30s keepalive ping)..."
  );

  _watchdogTimer = setInterval(async () => {
    if (_isReconnecting) return;

    try {
      if (!_sharedClient) {
        getSharedSupabaseClient(logger);
        return;
      }

      _pingCounter++;
      const isConnected = (_sharedClient.realtime as any)?.isConnected?.();

      // 1. WebSocket socket-level health check & auto-reconnect
      if (isConnected === false) {
        logger.warn(
          "[DeviceGatewayService] ⚠️ Watchdog: Realtime WebSocket disconnected. Reconnecting..."
        );
        _isReconnecting = true;
        try {
          _commandChannelReady = false;
          _commandChannelInitPromise = null;
          _commandChannel = null;
          _eventsChannel = null;
          _onboardingChannel = null;

          try {
            await _sharedClient.removeAllChannels();
          } catch (_) {}

          _sharedClient.realtime.disconnect();
          _sharedClient.realtime.connect();

          setTimeout(() => {
            setupSharedRealtimeChannels(logger);
            _isReconnecting = false;
          }, 2000);
          return;
        } catch (reconnErr: any) {
          logger.warn(
            `[DeviceGatewayService] Watchdog reconnect exception: ${reconnErr.message}`
          );
          _isReconnecting = false;
        }
        return;
      }

      // 2. Channel-level health check
      const commandState = (_commandChannel as any)?.state;
      const eventsState = (_eventsChannel as any)?.state;
      const onboardingState = (_onboardingChannel as any)?.state;

      if (
        !_commandChannel ||
        commandState === "closed" ||
        commandState === "errored"
      ) {
        logger.info(
          `[DeviceGatewayService] Watchdog: Refreshing command channel (prev: ${commandState || "null"})...`
        );
        safeTeardownChannel(_commandChannel);
        _commandChannel = null;
        _commandChannelReady = false;
        _commandChannelInitPromise = null;
        ensureSharedCommandChannel(logger);
      }

      if (
        !_eventsChannel ||
        eventsState === "closed" ||
        eventsState === "errored"
      ) {
        logger.info(
          `[DeviceGatewayService] Watchdog: Refreshing events channel (prev: ${eventsState || "null"})...`
        );
        setupEventsChannel(logger);
      }

      if (
        !_onboardingChannel ||
        onboardingState === "closed" ||
        onboardingState === "errored"
      ) {
        logger.info(
          `[DeviceGatewayService] Watchdog: Refreshing onboarding channel (prev: ${onboardingState || "null"})...`
        );
        setupOnboardingChannel(logger);
      }

      // 3. Keepalive Broadcast Ping every 30 seconds
      if (
        _pingCounter % 2 === 0 &&
        _commandChannel &&
        _commandChannelReady &&
        commandState === "joined"
      ) {
        try {
          const pingPromise = _commandChannel.send({
            type: "broadcast",
            event: "server_ping",
            payload: { timestamp: Math.floor(Date.now() / 1000) },
          });

          const sendRes = await Promise.race([
            pingPromise,
            new Promise<string>((_, reject) =>
              setTimeout(
                () => reject(new Error("Watchdog ping timeout (5s)")),
                5000
              )
            ),
          ]);

          if (sendRes !== "ok") {
            logger.warn(
              `[DeviceGatewayService] Watchdog ping returned '${sendRes}'. Refreshing command channel.`
            );
            _commandChannelReady = false;
            _commandChannelInitPromise = null;
            safeTeardownChannel(_commandChannel);
            _commandChannel = null;
            ensureSharedCommandChannel(logger);
          }
        } catch (pingErr: any) {
          logger.warn(
            `[DeviceGatewayService] Watchdog ping error: ${pingErr.message}. Refreshing command channel.`
          );
          _commandChannelReady = false;
          _commandChannelInitPromise = null;
          safeTeardownChannel(_commandChannel);
          _commandChannel = null;
          ensureSharedCommandChannel(logger);
        }
      }

      // 4. Auto-flush any stuck pending commands
      await flushStuckPendingCommands(logger);
    } catch (cycleErr: any) {
      logger.warn(
        `[DeviceGatewayService] Watchdog cycle warning: ${cycleErr.message}`
      );
    }
  }, 15000);

  if (_watchdogTimer.unref) {
    _watchdogTimer.unref();
  }
}

async function flushStuckPendingCommands(logger: any): Promise<void> {
  if (!_sharedClient) return;
  try {
    const twentySecAgo = new Date(Date.now() - 20 * 1000).toISOString();
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { data: stuckCommands } = await _sharedClient
      .from("device_command_logs")
      .select("*")
      .eq("status", "pending")
      .lt("created_at", twentySecAgo)
      .gt("created_at", tenMinAgo)
      .lt("retry_count", 3)
      .limit(5);

    if (!stuckCommands || stuckCommands.length === 0) return;

    logger.info(
      `[DeviceGatewayService] 🔄 Watchdog: Found ${stuckCommands.length} unacknowledged pending command(s). Re-dispatching...`
    );

    const secret =
      process.env.GATEWAY_SERVER_SECRET || "antigravity-secret-key-2026";

    for (const cmd of stuckCommands) {
      await _sharedClient
        .from("device_command_logs")
        .update({
          retry_count: (cmd.retry_count || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("command_id", cmd.command_id);

      const timestamp = Math.floor(Date.now() / 1000);
      const canonical = `${cmd.command_id}|${cmd.device_id}|${timestamp}|${cmd.action}|${JSON.stringify(cmd.payload)}`;
      const signature = crypto
        .createHmac("sha256", secret)
        .update(canonical)
        .digest("hex");

      const envelope = {
        command_id: cmd.command_id,
        device_id: cmd.device_id,
        timestamp,
        action: cmd.action,
        signature,
        payload: cmd.payload,
      };

      const sendStatus = await broadcastCommandEnvelope(envelope, logger);
      logger.info(
        `[DeviceGatewayService] Watchdog re-flushed command ${cmd.command_id} to '${cmd.device_id}'. Status: ${sendStatus}`
      );
    }
  } catch (err: any) {
    logger.warn(
      `[DeviceGatewayService] flushStuckPendingCommands warning: ${err.message}`
    );
  }
}

async function broadcastCommandEnvelope(
  envelope: any,
  logger: any
): Promise<string> {
  const client = getSharedSupabaseClient(logger);
  if (!client) return "no_client";

  await ensureSharedCommandChannel(logger);

  if (!_commandChannel) return "no_channel";

  try {
    const payloadWrapper = {
      type: "broadcast",
      event: "execute_command",
      ...envelope,
      payload: {
        ...envelope,
        ...envelope.payload,
        payload: envelope.payload,
      },
    };

    let status = await _commandChannel.send(payloadWrapper);

    if (status !== "ok") {
      logger.warn(
        `[DeviceGatewayService] Broadcast returned '${status}'. Refreshing channel and retrying...`
      );
      _commandChannelReady = false;
      _commandChannelInitPromise = null;
      safeTeardownChannel(_commandChannel);
      _commandChannel = null;
      await ensureSharedCommandChannel(logger);
      if (_commandChannel) {
        status = await _commandChannel.send(payloadWrapper);
      }
    }
    return status;
  } catch (err: any) {
    logger.warn(
      `[DeviceGatewayService] broadcastCommandEnvelope exception: ${err.message}`
    );
    return "error";
  }
}

async function flushPendingCommandsForDevice(
  deviceId: string,
  logger: any
): Promise<void> {
  if (!_sharedClient) return;
  try {
    const windowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: pendingCommands } = await _sharedClient
      .from("device_command_logs")
      .select("*")
      .eq("device_id", deviceId)
      .eq("status", "pending")
      .gte("created_at", windowStart)
      .order("created_at", { ascending: true })
      .limit(10);

    if (!pendingCommands || pendingCommands.length === 0) return;

    logger.info(
      `[DeviceGatewayService] 📲 Gateway '${deviceId}' checked in! Auto-flushing ${pendingCommands.length} pending SMS command(s)...`
    );

    const secret =
      process.env.GATEWAY_SERVER_SECRET || "antigravity-secret-key-2026";

    for (const cmd of pendingCommands) {
      const timestamp = Math.floor(Date.now() / 1000);
      const canonical = `${cmd.command_id}|${cmd.device_id}|${timestamp}|${cmd.action}|${JSON.stringify(cmd.payload)}`;
      const signature = crypto
        .createHmac("sha256", secret)
        .update(canonical)
        .digest("hex");

      const envelope = {
        command_id: cmd.command_id,
        device_id: cmd.device_id,
        timestamp,
        action: cmd.action,
        signature,
        payload: cmd.payload,
      };

      const sendStatus = await broadcastCommandEnvelope(envelope, logger);
      logger.info(
        `[DeviceGatewayService] Flushed pending command ${cmd.command_id} to '${deviceId}'. Status: ${sendStatus}`
      );
    }
  } catch (err: any) {
    logger.warn(
      `[DeviceGatewayService] flushPendingCommands error: ${err.message}`
    );
  }
}

function handleSharedDeviceEvent(event: any, logger: any): void {
  if (!event || !event.command_id) return;

  const { command_id, device_id, status, result, error_message, timestamp } =
    event;

  if (device_id) {
    _activeDevices.set(device_id, {
      lastSeen: timestamp || Math.floor(Date.now() / 1000),
    });
  }

  logger.info(
    `[DeviceGatewayService] Received device callback for command ${command_id} from ${device_id || "device"}: status=${status}`
  );

  const resolver = _pendingResolvers.get(command_id);
  if (resolver) {
    resolver({ status, result, error: error_message });
    _pendingResolvers.delete(command_id);
  }

  if (
    _sharedClient &&
    (status === "completed" || status === "failed" || status === "auth_failed")
  ) {
    _sharedClient
      .from("device_command_logs")
      .update({
        status,
        response: result || null,
        error_message: error_message || null,
        updated_at: new Date().toISOString(),
      })
      .eq("command_id", command_id)
      .then(({ error }) => {
        if (error) {
          logger.warn(
            `[DeviceGatewayService] Failed to update device_command_logs for ${command_id}: ${error.message}`
          );
        }
      });
  }
}

function handleSharedHeartbeat(payload: any, logger: any): void {
  if (!payload?.device_id) return;
  const deviceId = payload.device_id;
  _activeDevices.set(deviceId, {
    lastSeen: payload.timestamp || Math.floor(Date.now() / 1000),
    metadata: payload.metadata,
  });

  // Auto-flush any pending commands whenever the phone gateway sends a heartbeat
  flushPendingCommandsForDevice(deviceId, logger).catch((err) => {
    logger.warn(
      `[DeviceGatewayService] Error auto-flushing pending commands: ${err.message}`
    );
  });
}

@Service()
export class DeviceGatewayService extends TransactionBaseService {
  protected readonly logger_: Logger;

  constructor(container: any) {
    super(container);
    const fallbackLogger = {
      info: (msg: any) => console.log(msg),
      warn: (msg: any) => console.warn(msg),
      error: (msg: any) => console.error(msg),
    };

    try {
      this.logger_ =
        container?.logger ||
        (container?.resolve ? container.resolve("logger") : fallbackLogger);
    } catch (_) {
      this.logger_ = container?.logger || fallbackLogger;
    }

    if (!this.logger_ || typeof this.logger_.info !== "function") {
      this.logger_ = fallbackLogger as any;
    }

    // Initialize the shared singleton client (no-op if already done)
    getSharedSupabaseClient(this.logger_);
  }

  /**
   * Signs a command envelope using HMAC-SHA256 based on the canonical string specification:
   * canonical_string = "${command_id}|${device_id}|${timestamp}|${action}|${JSON.stringify(payload)}"
   */
  public signPayload(
    commandId: string,
    deviceId: string,
    timestamp: number,
    action: string,
    payload: any
  ): string {
    const secret =
      process.env.GATEWAY_SERVER_SECRET || "antigravity-secret-key-2026";
    const canonical = `${commandId}|${deviceId}|${timestamp}|${action}|${JSON.stringify(payload)}`;
    return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  }

  /**
   * Normalizes recipient phone number to standard international E.164 (+234...).
   */
  public normalizePhoneNumber(phone: string): string {
    const raw = phone.trim();
    if (raw.startsWith("+")) {
      return "+" + raw.replace(/\D/g, "");
    }
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("234")) {
      return "+" + digits;
    }
    if (digits.startsWith("0") && digits.length === 11) {
      return "+234" + digits.slice(1);
    }
    return "+" + digits;
  }

  /**
   * Dispatches an SMS or OTP message through the Android Cellular Edge Gateway.
   *
   * @param to Recipient phone number.
   * @param message SMS body text.
   * @param metadata Optional metadata (e.g. purpose: 'otp', user_id).
   * @param simSlot SIM card slot on device (0 for SIM 1, 1 for SIM 2).
   * @param targetDeviceId Device ID to route to, or "all" for any available gateway.
   * @param waitForAckMs Optional duration to await confirmation from the device before returning.
   */
  async sendSms(
    to: string,
    message: string,
    metadata?: Record<string, any>,
    simSlot: number = 0,
    targetDeviceId: string = "all",
    waitForAckMs: number = 0
  ): Promise<SendGatewaySmsResult> {
    const client = getSharedSupabaseClient(this.logger_);
    if (!client) {
      return {
        success: false,
        error: "Supabase client not configured for Phone Gateway",
      };
    }

    const commandId = crypto.randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    const action = "send_sms";
    // Resolve to an explicit device ID — never send to "all" to prevent duplicate execution
    const resolvedDeviceId =
      process.env.GATEWAY_TARGET_DEVICE_ID ||
      (targetDeviceId && targetDeviceId !== "all"
        ? targetDeviceId
        : "android_gateway_1");
    const deviceId = resolvedDeviceId;
    const formattedPhone = this.normalizePhoneNumber(to);

    // Alphabetical key ordering for canonical string match with Phoenix and Dart jsonEncode
    const payload: Record<string, any> = {
      message,
      phone_number: formattedPhone,
      sim_slot: simSlot,
    };

    const signature = this.signPayload(commandId, deviceId, timestamp, action, payload);

    try {
      // 1. Initial audit log insert in Supabase table
      const { error: insertErr } = await client
        .from("device_command_logs")
        .insert({
          command_id: commandId,
          device_id: deviceId,
          action,
          status: "pending",
          payload,
        });

      if (insertErr) {
        this.logger_.warn(
          `[DeviceGatewayService] Failed to record initial command log for ${commandId}: ${insertErr.message}`
        );
      }

      // 2. Broadcast command with automatic reconnection & retry
      const commandEnvelope = {
        command_id: commandId,
        device_id: deviceId,
        timestamp,
        action,
        signature,
        payload,
      };

      const sendStatus = await broadcastCommandEnvelope(
        commandEnvelope,
        this.logger_
      );

      this.logger_.info(
        `[DeviceGatewayService] Dispatched SMS command ${commandId} to target '${deviceId}' for ${formattedPhone}. Send status: ${sendStatus}`
      );

      // 3. Resilient background pulse: if still unacknowledged after 2.5s, send a 2nd pulse
      setTimeout(async () => {
        try {
          if (!_sharedClient) return;
          const { data } = await _sharedClient
            .from("device_command_logs")
            .select("status")
            .eq("command_id", commandId)
            .single();

          if (data && data.status === "pending") {
            const timestamp2 = Math.floor(Date.now() / 1000);
            const secret =
              process.env.GATEWAY_SERVER_SECRET || "antigravity-secret-key-2026";
            const canonical2 = `${commandId}|${deviceId}|${timestamp2}|${action}|${JSON.stringify(payload)}`;
            const signature2 = crypto
              .createHmac("sha256", secret)
              .update(canonical2)
              .digest("hex");

            const envelope2 = {
              command_id: commandId,
              device_id: deviceId,
              timestamp: timestamp2,
              action,
              signature: signature2,
              payload,
            };

            await broadcastCommandEnvelope(envelope2, this.logger_);
            this.logger_.info(
              `[DeviceGatewayService] Sent 2nd pulse for unacknowledged command ${commandId}`
            );
          }
        } catch (_) {}
      }, 2500);

      // 4. If caller requested synchronous acknowledgment, wait up to waitForAckMs
      if (waitForAckMs > 0) {
        const ackPromise = new Promise<{ status: string; result?: any; error?: string }>(
          (resolve) => {
            const timeout = setTimeout(() => {
              _pendingResolvers.delete(commandId);
              resolve({ status: "pending" });
            }, waitForAckMs);

            _pendingResolvers.set(commandId, (res) => {
              clearTimeout(timeout);
              resolve(res);
            });
          }
        );

        const ack = await ackPromise;
        if (ack.status === "failed" || ack.status === "auth_failed") {
          return {
            success: false,
            commandId,
            error: ack.error || `Device reported status: ${ack.status}`,
          };
        }
      }

      return {
        success: true,
        messageId: commandId,
        commandId,
        deviceId,
      };
    } catch (err: any) {
      this.logger_.error(
        `[DeviceGatewayService] Error dispatching SMS command to Phone Gateway: ${err.message}`
      );
      return {
        success: false,
        commandId,
        error: err.message,
      };
    }
  }

  /**
   * Broadcasts a ping command for liveness diagnostics.
   */
  async ping(targetDeviceId: string = "all"): Promise<SendGatewaySmsResult> {
    const client = getSharedSupabaseClient(this.logger_);
    if (!client) {
      return { success: false, error: "Supabase client not initialized" };
    }

    const commandId = crypto.randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    const action = "ping";
    const deviceId = targetDeviceId || "all";
    const payload = {};

    const signature = this.signPayload(commandId, deviceId, timestamp, action, payload);

    const envelope = {
      command_id: commandId,
      device_id: deviceId,
      timestamp,
      action,
      payload,
      signature,
    };

    try {
      await ensureSharedCommandChannel(this.logger_);

      if (_commandChannel) {
        await _commandChannel.send({
          type: "broadcast",
          event: "execute_command",
          payload: envelope,
        });
      }

      return { success: true, commandId, messageId: commandId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Fetches status of a command from the database.
   */
  async getCommandStatus(commandId: string): Promise<GatewayCommandLog | null> {
    const client = getSharedSupabaseClient(this.logger_);
    if (!client) return null;

    const { data, error } = await client
      .from("device_command_logs")
      .select("*")
      .eq("command_id", commandId)
      .single();

    if (error || !data) return null;
    return data as GatewayCommandLog;
  }

  /**
   * Retrieves recent gateway command logs for admin monitoring.
   */
  async getRecentLogs(limit: number = 50): Promise<GatewayCommandLog[]> {
    const client = getSharedSupabaseClient(this.logger_);
    if (!client) return [];

    const { data, error } = await client
      .from("device_command_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data as GatewayCommandLog[];
  }

  /**
   * Returns list of currently active or recently seen gateway devices.
   */
  public getActiveDevices(): Array<{ deviceId: string; lastSeen: number; metadata?: any }> {
    const list: Array<{ deviceId: string; lastSeen: number; metadata?: any }> = [];
    for (const [deviceId, info] of _activeDevices.entries()) {
      list.push({ deviceId, ...info });
    }
    return list;
  }
}

export default DeviceGatewayService;
