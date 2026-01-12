/**
 * /opt/ocpp-server/server.js — OCPP 1.6J Gateway (WS + HTTP) — FINAL (CORRIGIDO)
 *
 * ✅ Sem Express (evita ERR_MODULE_NOT_FOUND)
 * ✅ Base44: envia SEMPRE (mesmo quando logs de Heartbeat estão silenciados)
 * ✅ Logs mais limpos: por padrão NÃO loga Heartbeat IN/OUT
 * ✅ TXN manager:
 *    - salva txId (serverTransactionId retornado no StartTransaction)
 *    - ignora StartTransaction duplicado se TX já ativa
 *    - puxa MeterValues a cada X ms via TriggerMessage durante TX
 *    - injeta txId ativo nos MeterValues quando CP não manda transactionId
 *    - clamp/normaliza SoC (ex: 255 => 100; >100 => 100; <0 => 0)
 *    - StopTransaction finaliza mesmo se CP mandar transactionId=0
 *    - snapshot final (MeterValues + StatusNotification) e resumo
 *
 * Rotas HTTP:
 *  GET  /monitor
 *  GET  /ocpp/clients
 *  GET  /ocpp/transactions
 *  POST /ocpp/send
 *  POST /ocpp/stopAll
 *  POST /ocpp/stopAll/:serialNumber
 *
 * Compat Dashboard:
 *  GET /api/clients         (alias de /ocpp/clients)
 *  GET /api/transactions    (alias de /ocpp/transactions)
 */
import 'dotenv/config';

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);

// Base44
const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";
const API_KEY = process.env.API_KEY || "";

// Base44 command queue (pull queued commands from Base44)
const BASE44_COMMAND_QUEUE_URL =
  process.env.BASE44_COMMAND_QUEUE_URL ||
  ""; // ex: https://sua-app.base44.com/api/functions/processCommandQueue

const BASE44_COMMAND_STATUS_URL =
  process.env.BASE44_COMMAND_STATUS_URL ||
  ""; // ex: https://sua-app.base44.com/api/functions/updateCommandStatus

const COMMAND_POLL_ON_BOOT = String(process.env.COMMAND_POLL_ON_BOOT || "true") === "true";
const COMMAND_POLL_ON_HEARTBEAT = String(process.env.COMMAND_POLL_ON_HEARTBEAT || "true") === "true";
const COMMAND_POLL_MIN_INTERVAL_MS = Number(process.env.COMMAND_POLL_MIN_INTERVAL_MS || 3000);

// Base44 command push (webhook) -> Gateway
const COMMAND_PUSH_ENABLED = String(process.env.COMMAND_PUSH_ENABLED || "true") === "true";
const BASE44_WEBHOOK_SECRET = String(process.env.BASE44_WEBHOOK_SECRET || "");
const BASE44_WEBHOOK_PATH = String(process.env.BASE44_WEBHOOK_PATH || "/base44/command-webhook");

// timings
const BOOT_INTERVAL_SEC = Number(process.env.BOOT_INTERVAL_SEC || 30);
const BASE44_HEARTBEAT_SEC = Number(process.env.BASE44_HEARTBEAT_SEC || 30);

// keepalive/ping
const ENABLE_PING = String(process.env.ENABLE_PING || "false") === "true";
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 20000);
const TCP_KEEPALIVE_MS = Number(process.env.TCP_KEEPALIVE_MS || 15000);

// online ttl
const ONLINE_TTL_SEC = Number(process.env.ONLINE_TTL_SEC || 240);
const ONLINE_SWEEP_SEC = Number(process.env.ONLINE_SWEEP_SEC || 30);
const BASE44_ONLINE_PING_SEC = Number(process.env.BASE44_ONLINE_PING_SEC || 30);

// auto-commands after boot accepted
const AUTO_TRIGGER_STATUS =
  String(process.env.AUTO_TRIGGER_STATUS || "true") === "true";
const AUTO_TRIGGER_METER =
  String(process.env.AUTO_TRIGGER_METER || "false") === "true";
const AUTO_TRIGGER_CONNECTOR_ID = Number(process.env.AUTO_TRIGGER_CONNECTOR_ID || 1);

// TXN / meter pull
const METER_PULL_ENABLED = String(process.env.METER_PULL_ENABLED || "true") === "true";
const METER_PULL_INTERVAL_MS = Number(process.env.METER_PULL_INTERVAL_MS || 5000);
const METER_PULL_CONNECTOR_ID_DEFAULT = Number(process.env.METER_PULL_CONNECTOR_ID_DEFAULT || 1);

// Ignore MeterValues when there is NO active transaction (prevents "fake" session values)
const IGNORE_ORPHAN_METERVALUES = String(process.env.IGNORE_ORPHAN_METERVALUES || "true") === "true";


// logs
const LOG_PAYLOADS = String(process.env.LOG_PAYLOADS || "false") === "true"; // deixa false p/ log limpo

// Payload logs (granular)
const LOG_IN_PAYLOADS = String(process.env.LOG_IN_PAYLOADS || (LOG_PAYLOADS ? "true" : "false")) === "true";
const LOG_IN_CALLRESULT_PAYLOADS = String(process.env.LOG_IN_CALLRESULT_PAYLOADS || (LOG_PAYLOADS ? "true" : "false")) === "true";

const LOG_HEARTBEAT = String(process.env.LOG_HEARTBEAT || "false") === "true"; // ✅ por padrão NÃO loga heartbeat
const LOG_METER_EACH_PULL = String(process.env.LOG_METER_EACH_PULL || "true") === "true"; // logs de meter durante TX

// ===== Status polling (TriggerMessage StatusNotification 1..N) =====
const STATUS_POLL_ENABLED = String(process.env.STATUS_POLL_ENABLED || "true") === "true";
const STATUS_POLL_INTERVAL_MS = Number(process.env.STATUS_POLL_INTERVAL_MS || 10000);

// Prefer explicit list: "1,2" (recommended)
const STATUS_POLL_CONNECTORS = String(process.env.STATUS_POLL_CONNECTORS || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// Or fallback to max connectors (creates [1..N])
const STATUS_POLL_MAX_CONNECTORS = Number(process.env.STATUS_POLL_MAX_CONNECTORS || 0);

function getPollConnectorIds() {
  if (STATUS_POLL_CONNECTORS.length) return STATUS_POLL_CONNECTORS;
  if (STATUS_POLL_MAX_CONNECTORS > 0) {
    return Array.from({ length: STATUS_POLL_MAX_CONNECTORS }, (_, i) => i + 1);
  }
  return [AUTO_TRIGGER_CONNECTOR_ID || 1];
}

const statusPollTimers = new Map(); // serial -> interval
const statusPollIndex = new Map();  // serial -> idx (round-robin)


// “forçar” tentativa de voltar para Available no fim (se CP não enviar)
const FORCE_AVAILABLE_AFTER_STOP =
  String(process.env.FORCE_AVAILABLE_AFTER_STOP || "true") === "true";
const FORCE_AVAILABLE_DELAY_MS = Number(process.env.FORCE_AVAILABLE_DELAY_MS || 8000);

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };
const WS_OPEN = 1;

// ===== state =====
const clients = new Map(); // serial -> ws
const base44Timers = new Map(); // serial -> interval
const pendingCommands = new Map(); // serial -> array of {action, payload}
const pendingById = new Map(); // messageId -> { serialNumber, action, ts }

// Base44 queue polling + sent command tracking
const queuePollLast = new Map(); // serial -> ts last poll
const sentQueueCommands = new Map(); // ocppMessageId -> { serialNumber, action, sentAt }


// online tracking
const lastSeen = new Map(); // serial -> last traffic timestamp
const onlineState = new Map(); // serial -> bool
const base44OnlinePing = new Map(); // serial -> ts last ping

// connectors/status tracking
// serial -> Map(connectorId -> { status, timestamp })
const connectorStatus = new Map();

// TXN tracking
// serial -> { connectorId, idTag, serverTransactionId, startedAt, meterStartWh, lastMeterWh, lastSoc }
const txActive = new Map();
const meterPullTimers = new Map(); // serial -> interval

// ===== utils =====
function nowIso() {
  return new Date().toISOString();
}
function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}
function normalizeSerial(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.serialNumber) return String(v.serialNumber).trim();
    if (v.id) return String(v.id).trim();
    return "";
  }
  try {
    return decodeURIComponent(String(v)).trim();
  } catch {
    return String(v).trim();
  }
}
function safeSend(ws, arr) {
  if (!ws || ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(JSON.stringify(arr));
    return true;
  } catch {
    return false;
  }
}

function shouldLogAction(action) {
  if (action === "Heartbeat" && !LOG_HEARTBEAT) return false;
  return true;
}

function logIn(serial, action, messageId, payload) {
  if (!shouldLogAction(action)) return;
  const base = `[OCPP IN] ${serial} CALL action=${action} id=${messageId}`;
  if (LOG_IN_PAYLOADS) console.log(base + ` payload=${JSON.stringify(payload ?? {})}`);
  else console.log(base);
}
function logOutResult(serial, action, messageId) {
  if (!shouldLogAction(action)) return;
  console.log(`[OCPP OUT] ${serial} CALLRESULT action=${action} id=${messageId}`);
}
function logOutCall(serial, action, messageId, extra = "") {
  if (!shouldLogAction(action)) return;
  console.log(`[OCPP OUT] ${serial} CALL ${action} id=${messageId}${extra ? " " + extra : ""}`);
}
function logWarn(...args) {
  console.warn(...args);
}

// ===== ONLINE =====
function isOnline(serialNumber) {
  const ts = lastSeen.get(serialNumber);
  if (!ts) return false;
  return Date.now() - ts <= ONLINE_TTL_SEC * 1000;
}

function touchOnline(serialNumber, reason = "Heartbeat") {
  lastSeen.set(serialNumber, Date.now());

  const wasOnline = onlineState.get(serialNumber) === true;
  onlineState.set(serialNumber, true);

  if (!wasOnline) {
    console.log(`[ONLINE] ${serialNumber} agora ONLINE (${reason})`);
  }

  // ping Base44 com throttle (mantém dashboard vivo)
  const now = Date.now();
  const last = base44OnlinePing.get(serialNumber) || 0;
  if (now - last >= BASE44_ONLINE_PING_SEC * 1000) {
    base44OnlinePing.set(serialNumber, now);
    // ✅ status geral do CP: connectorId=0
    sendToBase44(serialNumber, msgStatus(0, "Available", reason)).catch(() => {});
  }
}

function markOffline(serialNumber, reason) {
  const wasOnline = onlineState.get(serialNumber) === true;
  onlineState.set(serialNumber, false);

  if (wasOnline) {
    console.log(`[ONLINE] ${serialNumber} agora OFFLINE (${reason})`);
    // ✅ status geral do CP: connectorId=0
    sendToBase44(serialNumber, msgStatus(0, "Unavailable", reason)).catch(() => {});
  }
}

// ===== Base44 =====
function inferEventType(_serialNumber, messageArray) {
  if (Array.isArray(messageArray)) {
    const t = messageArray[0];
    if (t === OCPP.CALL) {
      const action = messageArray[2];
      return typeof action === "string" && action ? action : "OCPP_CALL";
    }
    if (t === OCPP.CALLRESULT || t === OCPP.CALLERROR) {
      const id = messageArray[1];
      const meta = pendingById.get(id);
      const a = meta?.action;
      if (typeof a === "string" && a) return a;
      return t === OCPP.CALLRESULT ? "OCPP_CALLRESULT" : "OCPP_CALLERROR";
    }
  }
  return "OCPP_MESSAGE";
}

async function sendToBase44(serialNumber, messageArray) {
  if (!BASE44_URL) return;
  const event_type = inferEventType(serialNumber, messageArray);

  try {
    const res = await fetch(BASE44_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serialNumber,
        event_type, // ✅ Base44 exige string
        message: messageArray,
        ts: nowIso(),
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      console.warn("[Base44] falha:", res.status, txt);
    }
  } catch (e) {
    console.warn("[Base44] erro:", String(e?.message || e));
  }
}



// ===== Base44 Command Queue =====
async function pollCommandQueue(serialNumber, reason = "Heartbeat") {
  if (!BASE44_COMMAND_QUEUE_URL) {
    // console.log("[QUEUE] BASE44_COMMAND_QUEUE_URL vazio; skip");
    return;
  }

  const now = Date.now();
  const last = queuePollLast.get(serialNumber) || 0;
  const bypass = reason === "Base44Webhook";
  if (!bypass && now - last < COMMAND_POLL_MIN_INTERVAL_MS) return;
  queuePollLast.set(serialNumber, now);

  try {
    const payload = {
      // compat (você já usa)
      charger_id: serialNumber,
      serial_number: serialNumber,

      // ✅ extra compat (muita function usa isso)
      serialNumber: serialNumber,

      reason,
      ts: nowIso(),
    };

    const res = await fetch(BASE44_COMMAND_QUEUE_URL, {
      method: "POST",
      headers: {
     "Content-Type": "application/json",
     "X-Gateway-Token": BASE44_WEBHOOK_SECRET,

        // opcionais (ajudam em regras no Base44; pode remover se não quiser)
        "User-Agent": "ocpptarget-gateway/1.0",
        "X-Gateway-Host": "ocpptarget.cloud",
      },
      body: JSON.stringify(payload),
    });

    // ✅ lê texto primeiro para conseguir logar em erro e depois tenta JSON
    const txt = await res.text();
    let data = {};
    try { data = txt ? JSON.parse(txt) : {}; } catch { data = {}; }

    if (!res.ok) {
      // 🔥 log explícito quando a function bloquear/erro
      console.warn(
        `[QUEUE] ${serialNumber} fetch failed http=${res.status} reason=${reason} body=${String(txt).slice(0, 300)}`
      );
      return;
    }

    const commands = Array.isArray(data?.commands) ? data.commands : [];

    if (commands.length) {
      console.log(`[QUEUE] ${serialNumber} fetched ${commands.length} command(s) reason=${reason}`);
    } else {
      // ✅ log leve pra você saber que buscou e veio vazio
      console.log(`[QUEUE] ${serialNumber} queue empty reason=${reason}`);
    }

    const ws = clients.get(serialNumber);
    if (!ws || ws.readyState !== WS_OPEN) {
      if (commands.length) console.log(`[QUEUE] ${serialNumber} offline -> cannot send queued commands`);
      return;
    }

    for (const cmd of commands) {
      const msg = cmd?.ocppMessage;

      if (!Array.isArray(msg) || msg.length < 3) {
        console.warn("[QUEUE] comando inválido:", cmd);
        continue;
      }

      const messageId = msg[1];
      const action = msg[2];

      // Track in pendingById so CALLRESULT/CALLERROR can infer event_type and we can update Base44 command status
      pendingById.set(messageId, { serialNumber, action: `QUEUE:${action}`, ts: Date.now() });
      sentQueueCommands.set(messageId, { serialNumber, action: String(action || ""), sentAt: Date.now() });

      const ok = safeSend(ws, msg);
      logOutCall(serialNumber, String(action || "OCPP"), String(messageId), `ok=${ok} (from Base44 queue)`);

      if (!ok) break;
    }
  } catch (e) {
    console.warn("[QUEUE] erro:", String(e?.message || e));
  }
}


async function updateCommandStatus(messageId, status, responsePayload) {
  if (!BASE44_COMMAND_STATUS_URL) return;
  try {
    await fetch(BASE44_COMMAND_STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message_id: messageId,
        status,
        response: responsePayload ?? null,
        ts: nowIso(),
      }),
    });
  } catch (e) {
    console.warn("[QUEUE] updateCommandStatus erro:", String(e?.message || e));
  }
}
// ===== messages helpers =====
function msgStatus(connectorId, status, info) {
  return [
    OCPP.CALL,
    `st-${connectorId}-${String(status || "").toLowerCase()}-${Date.now()}`,
    "StatusNotification",
    {
      connectorId: Number(connectorId),
      status,
      errorCode: "NoError",
      info: info || undefined,
      timestamp: nowIso(),
    },
  ];
}

function msgHeartbeat() {
  return [OCPP.CALL, "hb-" + Date.now(), "Heartbeat", {}];
}

// ===== OCPP immediate responses =====
function buildImmediateCallResult(action, payload) {
  switch (action) {
    case "BootNotification":
      return { status: "Accepted", currentTime: nowIso(), interval: BOOT_INTERVAL_SEC };
    case "Heartbeat":
      return { currentTime: nowIso() };
    case "StatusNotification":
      return {};
    case "Authorize":
      return { idTagInfo: { status: "Accepted" } };
    case "StartTransaction": {
      // server-side tx id
      const serverTransactionId = Math.floor(Date.now() / 1000);
      return { transactionId: serverTransactionId, idTagInfo: { status: "Accepted" } };
    }
    case "StopTransaction":
      return { idTagInfo: { status: "Accepted" } };
    case "MeterValues":
      return {};
    case "DataTransfer":
      return { status: "Accepted", data: "" };
    case "DiagnosticsStatusNotification":
    case "FirmwareStatusNotification":
      return {};
    default:
      return null;
  }
}

// ===== auto commands after boot =====
function enqueueAutoCommands(serialNumber) {
  const q = [];

  if (AUTO_TRIGGER_STATUS) {
    q.push({
      action: "TriggerMessage",
      payload: { requestedMessage: "StatusNotification", connectorId: AUTO_TRIGGER_CONNECTOR_ID },
    });
  }
  if (AUTO_TRIGGER_METER) {
    q.push({
      action: "TriggerMessage",
      payload: { requestedMessage: "MeterValues", connectorId: AUTO_TRIGGER_CONNECTOR_ID },
    });
  }

  pendingCommands.set(serialNumber, q);
}

function flushPendingCommands(serialNumber, ws) {
  const q = pendingCommands.get(serialNumber) || [];
  if (!q.length) return;

  for (const cmd of q) {
    const messageId = uid();
    pendingById.set(messageId, { serialNumber, action: cmd.action, ts: Date.now() });

    const ok = safeSend(ws, [OCPP.CALL, messageId, cmd.action, cmd.payload || {}]);
    logOutCall(serialNumber, cmd.action, messageId, `ok=${ok}`);

    if (!ok) break;
  }
  pendingCommands.set(serialNumber, []);
}

// ===== Status poll helpers =====
function sendTriggerStatus(serialNumber, connectorId, tag = "Poll") {
  const ws = clients.get(serialNumber);
  if (!ws || ws.readyState !== WS_OPEN) return false;

  const messageId = uid();
  pendingById.set(messageId, {
    serialNumber,
    action: `TriggerMessage(StatusNotification-${tag})`,
    ts: Date.now(),
  });

  const ok = safeSend(ws, [
    OCPP.CALL,
    messageId,
    "TriggerMessage",
    { requestedMessage: "StatusNotification", connectorId: Number(connectorId) },
  ]);

  logOutCall(
    serialNumber,
    "TriggerMessage",
    messageId,
    `connectorId=${connectorId} ok=${ok} (status-${tag.toLowerCase()})`
  );
  return ok;
}

function startStatusPoll(serialNumber) {
  if (!STATUS_POLL_ENABLED) return;
  if (statusPollTimers.has(serialNumber)) return;

  const ids = getPollConnectorIds();
  statusPollIndex.set(serialNumber, 0);

  const t = setInterval(() => {
    // Só roda se online "de verdade"
    if (!isOnline(serialNumber)) return;

    const idx = statusPollIndex.get(serialNumber) || 0;
    const connectorId = ids[idx % ids.length];
    statusPollIndex.set(serialNumber, (idx + 1) % ids.length);

    sendTriggerStatus(serialNumber, connectorId, "Poll");
  }, STATUS_POLL_INTERVAL_MS);

  statusPollTimers.set(serialNumber, t);
}

function stopStatusPoll(serialNumber) {
  const t = statusPollTimers.get(serialNumber);
  if (t) clearInterval(t);
  statusPollTimers.delete(serialNumber);
  statusPollIndex.delete(serialNumber);
}


// ===== Status tracking =====
function setConnectorStatus(serialNumber, connectorId, status, timestamp) {
  if (!connectorStatus.has(serialNumber)) connectorStatus.set(serialNumber, new Map());
  connectorStatus.get(serialNumber).set(Number(connectorId), {
    status: String(status || ""),
    timestamp: timestamp || nowIso(),
  });
}

// ===== MeterValues normalize + extract helpers =====
function normalizeMeterValues(serialNumber, payload) {
  const out = {
    serialNumber,
    connectorId: payload?.connectorId ?? null,
    transactionId: payload?.transactionId ?? null,
    ts: nowIso(),
    points: [],
  };

  const arr = Array.isArray(payload?.meterValue) ? payload.meterValue : [];
  for (const mv of arr) {
    const tstamp = mv?.timestamp || null;
    const sv = Array.isArray(mv?.sampledValue) ? mv.sampledValue : [];
    for (const s of sv) {
      out.points.push({
        timestamp: tstamp,
        value: s?.value ?? null,
        measurand: s?.measurand ?? null,
        unit: s?.unit ?? null,
        phase: s?.phase ?? null,
        location: s?.location ?? null,
        context: s?.context ?? null,
        format: s?.format ?? null,
      });
    }
  }
  return out;
}

function extractEnergyWhFromMeterValuesPayload(payload) {
  const arr = Array.isArray(payload?.meterValue) ? payload.meterValue : [];
  for (const mv of arr) {
    const sv = Array.isArray(mv?.sampledValue) ? mv.sampledValue : [];
    for (const s of sv) {
      if (s?.measurand === "Energy.Active.Import.Register") {
        const v = Number(String(s.value ?? "").replace(",", "."));
        if (!Number.isNaN(v)) {
          if (String(s.unit || "").toLowerCase() === "kwh") return Math.round(v * 1000);
          return Math.round(v); // Wh
        }
      }
    }
  }
  return null;
}

function extractSoCPercentFromMeterValuesPayload(payload) {
  const arr = Array.isArray(payload?.meterValue) ? payload.meterValue : [];
  for (const mv of arr) {
    const sv = Array.isArray(mv?.sampledValue) ? mv.sampledValue : [];
    for (const s of sv) {
      if (s?.measurand === "SoC") {
        const raw = Number(String(s.value ?? "").replace(",", "."));
        if (Number.isNaN(raw)) return null;

        // ✅ normalizações comuns (muitos carregadores chineses usam 255 como placeholder)
        if (raw === 255) return 100;
        if (raw > 100) return 100;
        if (raw < 0) return 0;
        return Math.round(raw);
      }
    }
  }
  return null;
}

// ===== TXN / meter pull =====
function startMeterPullLoop(serialNumber) {
  if (!METER_PULL_ENABLED) return;
  if (meterPullTimers.has(serialNumber)) return;

  const t = setInterval(() => {
    const ws = clients.get(serialNumber);
    if (!ws || ws.readyState !== WS_OPEN) return;

    const tx = txActive.get(serialNumber);
    if (!tx) return;

    const connectorId = tx.connectorId ?? METER_PULL_CONNECTOR_ID_DEFAULT;

    const messageId = uid();
    pendingById.set(messageId, { serialNumber, action: "TriggerMessage(MeterValues)", ts: Date.now() });

    const ok = safeSend(ws, [
      OCPP.CALL,
      messageId,
      "TriggerMessage",
      { requestedMessage: "MeterValues", connectorId },
    ]);

    if (LOG_METER_EACH_PULL) {
      console.log(
        `[TXN] ${serialNumber} pull MeterValues every=${METER_PULL_INTERVAL_MS}ms connectorId=${connectorId} ok=${ok} id=${messageId}`
      );
    }
  }, METER_PULL_INTERVAL_MS);

  meterPullTimers.set(serialNumber, t);
}

function stopMeterPullLoop(serialNumber) {
  const t = meterPullTimers.get(serialNumber);
  if (t) clearInterval(t);
  meterPullTimers.delete(serialNumber);
}

function triggerFinalSnapshots(serialNumber, connectorId) {
  const ws = clients.get(serialNumber);
  if (!ws || ws.readyState !== WS_OPEN) return;

  // final MeterValues
  const id1 = uid();
  pendingById.set(id1, { serialNumber, action: "TriggerMessage(MeterValues-Final)", ts: Date.now() });
  safeSend(ws, [OCPP.CALL, id1, "TriggerMessage", { requestedMessage: "MeterValues", connectorId }]);
  console.log(`[TXN] ${serialNumber} final snapshot MeterValues connectorId=${connectorId} id=${id1}`);

  // final StatusNotification
  const id2 = uid();
  pendingById.set(id2, { serialNumber, action: "TriggerMessage(StatusNotification-Final)", ts: Date.now() });
  safeSend(ws, [OCPP.CALL, id2, "TriggerMessage", { requestedMessage: "StatusNotification", connectorId }]);
  console.log(`[TXN] ${serialNumber} final snapshot StatusNotification connectorId=${connectorId} id=${id2}`);
}

function logTxnSummary(serialNumber, reason = "StopTransaction") {
  const tx = txActive.get(serialNumber);
  if (!tx) return;

  const durSec = Math.max(0, Math.floor((Date.now() - tx.startedAt) / 1000));
  const whStart = tx.meterStartWh ?? null;
  const whLast = tx.lastMeterWh ?? null;

  let deltaWh = null;
  if (whStart != null && whLast != null) deltaWh = Math.max(0, whLast - whStart);

  console.log(
    `[SUMMARY] ${serialNumber} reason=${reason} connectorId=${tx.connectorId} txId=${tx.serverTransactionId} durationSec=${durSec} meterStartWh=${whStart} meterLastWh=${whLast} deltaWh=${deltaWh} lastSoC=${tx.lastSoc ?? "n/a"}`
  );
}

// ===== remote stop =====
function sendRemoteStop(serialNumber, transactionId) {
  const ws = clients.get(serialNumber);
  if (!ws || ws.readyState !== WS_OPEN) return { ok: false, error: "charger offline" };

  const messageId = uid();
  pendingById.set(messageId, { serialNumber, action: "RemoteStopTransaction", ts: Date.now() });

  const ok = safeSend(ws, [OCPP.CALL, messageId, "RemoteStopTransaction", { transactionId: Number(transactionId) }]);
  console.log(`[OCPP OUT] ${serialNumber} RemoteStopTransaction txId=${transactionId} id=${messageId} ok=${ok} (stopAll)`);
  return { ok, messageId };
}

// ========= HTTP =========
function writeJson(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return writeJson(res, 200, { ok: true });

  // ===== Base44 -> Gateway webhook (push notify) =====
  // Accepts exact path, optional trailing slash, and also auto-handles optional "/ocpp" prefix differences (Nginx vs localhost).
  const pathOnly = String(req.url || "").split("?")[0];

  const webhookCandidates = new Set([
    BASE44_WEBHOOK_PATH,
    BASE44_WEBHOOK_PATH.endsWith("/") ? BASE44_WEBHOOK_PATH.slice(0, -1) : (BASE44_WEBHOOK_PATH + "/"),
  ]);

  // If BASE44_WEBHOOK_PATH is under /ocpp, also accept same path without /ocpp (useful for localhost).
  if (BASE44_WEBHOOK_PATH.startsWith("/ocpp/")) {
    const noPrefix = BASE44_WEBHOOK_PATH.replace(/^\/ocpp\//, "/");
    webhookCandidates.add(noPrefix);
    webhookCandidates.add(noPrefix.endsWith("/") ? noPrefix.slice(0, -1) : (noPrefix + "/"));
  } else {
    // If not under /ocpp, also accept with /ocpp prefix (useful for domain behind Nginx that prefixes /ocpp).
    const withPrefix = "/ocpp" + (BASE44_WEBHOOK_PATH.startsWith("/") ? "" : "/") + BASE44_WEBHOOK_PATH;
    webhookCandidates.add(withPrefix);
    webhookCandidates.add(withPrefix.endsWith("/") ? withPrefix.slice(0, -1) : (withPrefix + "/"));
  }

  if (COMMAND_PUSH_ENABLED && req.method === "POST" && webhookCandidates.has(pathOnly)) {
    if (BASE44_WEBHOOK_SECRET) {
      const got = String(req.headers["x-webhook-secret"] || "");
      if (got !== BASE44_WEBHOOK_SECRET) {
        return writeJson(res, 401, { ok: false, error: "invalid webhook secret" });
      }
    }

    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return writeJson(res, 400, { ok: false, error: "invalid json" });
    }

    const sn = normalizeSerial(
      body?.serialNumber || body?.serial_number || body?.charger_id || body?.chargerId || body?.id
    );

    if (!sn) return writeJson(res, 400, { ok: false, error: "missing serialNumber" });

    console.log(`[WEBHOOK] Base44 command notify serial=${sn} path=${pathOnly} ts=${nowIso()}`);

    // Pull queue immediately (bypass throttle via reason)
    pollCommandQueue(sn, "Base44Webhook").catch(() => {});
    return writeJson(res, 200, { ok: true });
  }


  if (req.method === "GET" && req.url === "/monitor") {
    return writeJson(res, 200, { ok: true, ts: nowIso() });
  }

  // clients list
  if (req.method === "GET" && (req.url === "/ocpp/clients" || req.url === "/api/clients")) {
    const list = [...clients.keys()].map((serial) => {
      const ts = lastSeen.get(serial) || null;
      const tx = txActive.get(serial);
      return {
        serialNumber: serial,
        online: isOnline(serial),
        lastSeen: ts ? new Date(ts).toISOString() : null,
        ageSec: ts ? Math.floor((Date.now() - ts) / 1000) : null,
        txActive: !!tx,
        txId: tx?.serverTransactionId ?? null,
        connectorId: tx?.connectorId ?? null,
        lastSoc: tx?.lastSoc ?? null,
      };
    });

    return writeJson(res, 200, {
      ok: true,
      count: clients.size,
      ttlSec: ONLINE_TTL_SEC,
      clients: list,
      ts: nowIso(),
    });
  }

  // active transactions
  if (req.method === "GET" && (req.url === "/ocpp/transactions" || req.url === "/api/transactions")) {
    const list = [...txActive.entries()].map(([serial, tx]) => ({
      serialNumber: serial,
      connectorId: tx.connectorId ?? null,
      serverTransactionId: tx.serverTransactionId ?? null,
      idTag: tx.idTag ?? null,
      startedAt: tx.startedAt ? new Date(tx.startedAt).toISOString() : null,
      meterStartWh: tx.meterStartWh ?? null,
      lastMeterWh: tx.lastMeterWh ?? null,
      deltaWh:
        tx.meterStartWh != null && tx.lastMeterWh != null
          ? Math.max(0, tx.lastMeterWh - tx.meterStartWh)
          : null,
      lastSoc: tx.lastSoc ?? null,
    }));

    return writeJson(res, 200, { ok: true, count: list.length, transactions: list, ts: nowIso() });
  }

  // send command
  if (req.method === "POST" && req.url === "/ocpp/send") {
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
      return writeJson(res, 401, { ok: false, error: "unauthorized" });
    }

    let json;
    try {
      json = JSON.parse(await readBody(req));
    } catch {
      return writeJson(res, 400, { ok: false, error: "invalid json" });
    }

    const { serialNumber, action, payload } = json || {};
    const sn = normalizeSerial(serialNumber);
    const ws = clients.get(sn);

    if (!sn) return writeJson(res, 400, { ok: false, error: "invalid serialNumber" });
    if (!ws || ws.readyState !== WS_OPEN) return writeJson(res, 404, { ok: false, error: "charger offline" });

    const messageId = uid();
    pendingById.set(messageId, { serialNumber: sn, action, ts: Date.now() });

    const ok = safeSend(ws, [OCPP.CALL, messageId, action, payload || {}]);
    logOutCall(sn, action, messageId, `ok=${ok} (via HTTP)`);

    return writeJson(res, ok ? 200 : 500, { ok, messageId });
  }

  // stop all
  if (req.method === "POST" && req.url === "/ocpp/stopAll") {
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
      return writeJson(res, 401, { ok: false, error: "unauthorized" });
    }

    const results = [];
    for (const [serial, tx] of txActive.entries()) {
      if (tx?.serverTransactionId == null) {
        results.push({ serialNumber: serial, ok: false, error: "missing transactionId" });
        continue;
      }
      results.push({ serialNumber: serial, ...sendRemoteStop(serial, tx.serverTransactionId) });
    }
    return writeJson(res, 200, { ok: true, count: results.length, results, ts: nowIso() });
  }

  // stop all for one serial
  if (req.method === "POST" && req.url && req.url.startsWith("/ocpp/stopAll/")) {
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
      return writeJson(res, 401, { ok: false, error: "unauthorized" });
    }

    const serial = normalizeSerial(req.url.split("/").pop());
    const tx = txActive.get(serial);

    if (!tx || tx.serverTransactionId == null) {
      return writeJson(res, 404, { ok: false, error: "no active transaction for this serial" });
    }

    const out = sendRemoteStop(serial, tx.serverTransactionId);
    return writeJson(res, out.ok ? 200 : 500, { ...out, serialNumber: serial, ts: nowIso() });
  }

  return writeJson(res, 404, { ok: false, error: "not found" });
});

// ========= WS =========
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  handleProtocols: (protocols) => {
    const list = protocols instanceof Set ? [...protocols] : protocols || [];
    if (list.includes("ocpp1.6")) return "ocpp1.6";
    return undefined;
  },
});

wss.on("connection", (ws, req) => {
  const u = new URL(req.url || "/", "http://local");
  const parts = u.pathname.split("/").filter(Boolean);
  const serialNumber = normalizeSerial(parts.pop() || "") || "UNKNOWN";

  const protoHeader = String(req.headers["sec-websocket-protocol"] || "");
  const negotiated = String(ws.protocol || "");

  console.log(
    `[WS] conectado ${serialNumber} | negotiated="${negotiated}" | header="${protoHeader}" | path="${u.pathname}" | ${nowIso()}`
  );

  if (serialNumber === "UNKNOWN" || serialNumber === "monitor") {
    try {
      ws.close(1008, "Invalid path");
    } catch {}
    return;
  }

  clients.set(serialNumber, ws);
  lastSeen.set(serialNumber, Date.now());

  // online initial ping Base44 (status geral: connectorId=0)
  sendToBase44(serialNumber, msgStatus(0, "Available", "WS Connected")).catch(() => {});

  // TCP keepalive
  try {
    ws._socket && ws._socket.setKeepAlive(true, TCP_KEEPALIVE_MS);
  } catch {}

  // ping watchdog optional
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  enqueueAutoCommands(serialNumber);

  // internal heartbeat to Base44 (não é o heartbeat do carregador)
  const t = setInterval(() => {
    const cur = clients.get(serialNumber);
    if (!cur || cur.readyState !== WS_OPEN) return;
    sendToBase44(serialNumber, msgHeartbeat()).catch(() => {});
  }, BASE44_HEARTBEAT_SEC * 1000);
  base44Timers.set(serialNumber, t);

  ws.on("message", (data) => {
    const rawText = data.toString();
    let msg;

    try {
      msg = JSON.parse(rawText);
    } catch {
      logWarn("[WS] JSON inválido:", rawText);
      return;
    }

    if (!Array.isArray(msg) || msg.length < 2) {
      logWarn("[WS] formato inválido:", msg);
      return;
    }

    lastSeen.set(serialNumber, Date.now());

    const messageTypeId = msg[0];

    // ===== CP -> CSMS: CALL =====
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      // log (limpo)
      logIn(serialNumber, action, messageId, payload);

      // ✅ Log detalhado do StatusNotification (independente de LOG_PAYLOADS)
      if (action === "StatusNotification") {
        const p = payload || {};
        console.log(
          `[STATUS] ${serialNumber} connectorId=${p.connectorId} status=${p.status} errorCode=${p.errorCode} ts=${p.timestamp || "n/a"}`
        );
      }

      // ONLINE real: somente Boot/Heartbeat
      if (action === "Heartbeat") touchOnline(serialNumber, "Heartbeat");
      if (COMMAND_POLL_ON_HEARTBEAT) pollCommandQueue(serialNumber, "Heartbeat").catch(() => {});
      if (action === "BootNotification") touchOnline(serialNumber, "BootNotification");
      if (COMMAND_POLL_ON_BOOT) pollCommandQueue(serialNumber, "BootNotification").catch(() => {});

      // responder imediato
      const respPayload = buildImmediateCallResult(action, payload);

      if (respPayload === null) {
        safeSend(ws, [OCPP.CALLERROR, messageId, "NotImplemented", "Action " + action + " not supported", {}]);
        if (shouldLogAction(action)) {
          console.log(`[OCPP OUT] ${serialNumber} CALLERROR action=${action} id=${messageId} (NotImplemented)`);
        }
      } else {
        safeSend(ws, [OCPP.CALLRESULT, messageId, respPayload]);
        logOutResult(serialNumber, action, messageId);
      }

      // SEMPRE envia pro Base44 (mesmo Heartbeat silenciado)
      sendToBase44(serialNumber, msg).catch(() => {});

      // StatusNotification tracking
      if (action === "StatusNotification") {
        const cid = payload?.connectorId ?? 0;
        setConnectorStatus(serialNumber, cid, payload?.status ?? "", payload?.timestamp || nowIso());
      }

      // TXN start
      if (action === "StartTransaction" && respPayload && respPayload.transactionId != null) {
        const existing = txActive.get(serialNumber);
        if (existing) {
          console.log(
            `[TXN] ${serialNumber} DUP StartTransaction ignored (already active txId=${existing.serverTransactionId})`
          );
        } else {
          const connectorId = payload?.connectorId ?? METER_PULL_CONNECTOR_ID_DEFAULT;
          const meterStartWh =
            payload?.meterStart != null && Number.isFinite(Number(payload.meterStart))
              ? Number(payload.meterStart)
              : null;

          txActive.set(serialNumber, {
            connectorId,
            idTag: payload?.idTag ?? null,
            serverTransactionId: respPayload.transactionId,
            startedAt: Date.now(),
            meterStartWh,
            lastMeterWh: meterStartWh,
            lastSoc: null,
          });

          console.log(
            `[TXN] ${serialNumber} START connectorId=${connectorId} txId=${respPayload.transactionId} meterStartWh=${meterStartWh}`
          );

          startMeterPullLoop(serialNumber);
        }
      }

      // StopTransaction finaliza mesmo se CP mandar transactionId=0
      if (action === "StopTransaction") {
        const tx = txActive.get(serialNumber);
        const connectorId = tx?.connectorId ?? payload?.connectorId ?? METER_PULL_CONNECTOR_ID_DEFAULT;

        console.log(
          `[TXN] ${serialNumber} STOP cpTxId=${payload?.transactionId ?? null} serverTxId=${tx?.serverTransactionId ?? null} reason=${payload?.reason ?? ""}`
        );

        // tenta atualizar energia final via transactionData (se vier)
        try {
          const whFromStop = extractEnergyWhFromMeterValuesPayload({
            meterValue: payload?.transactionData || [],
          });
          if (whFromStop != null && tx) tx.lastMeterWh = whFromStop;
        } catch {}

        stopMeterPullLoop(serialNumber);

        // snapshots finais
        setTimeout(() => triggerFinalSnapshots(serialNumber, connectorId), 800);

        // resumo
        logTxnSummary(serialNumber, "StopTransaction");

        // se carregador não voltar p/ Available, tenta “puxar” status e publicar evento
        if (FORCE_AVAILABLE_AFTER_STOP) {
          setTimeout(() => {
            const st = connectorStatus.get(serialNumber)?.get(connectorId)?.status;
            if (st && String(st).toLowerCase() === "available") return;

            const ws2 = clients.get(serialNumber);
            if (!ws2 || ws2.readyState !== WS_OPEN) return;

            const mid = uid();
            pendingById.set(mid, { serialNumber, action: "TriggerMessage(StatusNotification-Force)", ts: Date.now() });
            safeSend(ws2, [OCPP.CALL, mid, "TriggerMessage", { requestedMessage: "StatusNotification", connectorId }]);

            console.log(`[TXN] ${serialNumber} force StatusNotification check connectorId=${connectorId} id=${mid}`);

            // publica “status” sintético pro Base44 (NÃO altera o CP, só seu dashboard)
            sendToBase44(serialNumber, msgStatus(connectorId, "Available", "Post-Stop (synthetic)")).catch(() => {});
          }, FORCE_AVAILABLE_DELAY_MS);
        }

        // limpa tx state
        setTimeout(() => {
          txActive.delete(serialNumber);
          console.log(`[TXN] ${serialNumber} cleared tx state`);
        }, 5000);

        return;
      }

      // MeterValues (normaliza + injeta txId + clamp SoC)
      if (action === "MeterValues") {
        try {
        const tx0 = txActive.get(serialNumber);

        // ✅ Se não tem transação ativa, isso NÃO é recarga iniciada.
        // Evita "contaminar" o Base44 com MeterValues de sessão inexistente.
        if (!tx0 && IGNORE_ORPHAN_METERVALUES) {
          console.log(
            `[METER] ${serialNumber} IGNORADO (sem tx ativa) connectorId=${payload?.connectorId ?? "n/a"} ` +
              `cpTxId=${payload?.transactionId ?? "n/a"}`
          );
          return;
        }

          const normalized = normalizeMeterValues(serialNumber, payload);

          const tx = txActive.get(serialNumber);
          if (tx && normalized.transactionId == null) {
            normalized.transactionId = tx.serverTransactionId; // injeta
          }

          // energia
          const wh = extractEnergyWhFromMeterValuesPayload(payload);
          if (wh != null && tx) {
            tx.lastMeterWh = wh;
          }

          // SoC
          const soc = extractSoCPercentFromMeterValuesPayload(payload);
          if (soc != null && tx) {
            if (tx.lastSoc == null || Math.abs(soc - tx.lastSoc) <= 30 || soc === 100) {
              tx.lastSoc = soc;
            } else {
              console.log(`[SOC] ${serialNumber} valor estranho soc=${soc} (last=${tx.lastSoc}) — ignorado no estado`);
            }
          }

          if (tx) txActive.set(serialNumber, tx);

          if (LOG_METER_EACH_PULL) {
            console.log(
              `[METER] ${serialNumber} txId=${normalized.transactionId ?? "n/a"} ` +
                `energyWh=${wh ?? "n/a"} soc=${soc ?? "n/a"}`
            );
          }

          // manda evento “limpo” pro Base44
          sendToBase44(serialNumber, ["event", "meter_values", normalized]).catch(() => {});
        } catch (e) {
          logWarn("[METER] parse falhou:", String(e?.message || e));
        }
      }

      // boot accepted => auto commands
      if (action === "BootNotification" && respPayload && respPayload.status === "Accepted") {
        setTimeout(() => flushPendingCommands(serialNumber, ws), 200);

        // ✅ Dispara StatusNotification para 1..N logo após BootAccepted (stagger)
        const ids = getPollConnectorIds();
        ids.forEach((cid, i) => setTimeout(() => sendTriggerStatus(serialNumber, cid, "Boot"), 400 + i * 250));

        // ✅ Inicia job de polling enquanto estiver online
        startStatusPoll(serialNumber);
      }

      return;
    }

    // ===== CP -> CSMS: CALLRESULT / CALLERROR =====
    if (messageTypeId === OCPP.CALLRESULT || messageTypeId === OCPP.CALLERROR) {
      const id = msg[1];
      const meta = pendingById.get(id);

      if (meta) {
        const ms = Date.now() - meta.ts;

        // If this was a queued command sent from Base44, update its status there
        const q = sentQueueCommands.get(id);
        if (q) {
          try {
            if (messageTypeId === OCPP.CALLRESULT) {
              updateCommandStatus(id, "success", msg[2] ?? {}).catch(() => {});
            } else {
              updateCommandStatus(id, "error", { error: msg.slice(2) }).catch(() => {});
            }
          } catch {}
          sentQueueCommands.delete(id);
        }

        const actionName = String(meta.action || "");
        const isHbMeta = actionName.includes("Heartbeat");
        if (!(isHbMeta && !LOG_HEARTBEAT)) {
          if (messageTypeId === OCPP.CALLRESULT) {
            const payload = msg[2] ?? {};
            console.log(
              `[OCPP IN] ${serialNumber} CALLRESULT for=${meta.action} id=${id} in ${ms}ms` +
                (LOG_IN_CALLRESULT_PAYLOADS ? ` payload=${JSON.stringify(payload)}` : "")
            );
          } else {
            console.log(
              `[OCPP IN] ${serialNumber} CALLERROR for=${meta.action} id=${id} in ${ms}ms err=${JSON.stringify(
                msg.slice(2)
              )}`
            );
          }
        }

        pendingById.delete(id);
      }

      // Base44 sempre
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }

    logWarn(`[OCPP IN] ${serialNumber} tipo desconhecido:`, messageTypeId, msg);
  });

  ws.on("close", (code, reasonBuf) => {
    stopStatusPoll(serialNumber);

    const reason = (reasonBuf ? reasonBuf.toString() : "") || "";
    console.log(`[WS] close ${serialNumber} code=${code} reason="${reason}" at ${nowIso()}`);

    const it = base44Timers.get(serialNumber);
    if (it) clearInterval(it);
    base44Timers.delete(serialNumber);

    stopMeterPullLoop(serialNumber);
    txActive.delete(serialNumber);

    clients.delete(serialNumber);
    pendingCommands.delete(serialNumber);

    for (const [id, meta] of pendingById.entries()) {
      if (meta.serialNumber === serialNumber) pendingById.delete(id);
    }

    lastSeen.delete(serialNumber);
    onlineState.delete(serialNumber);
    base44OnlinePing.delete(serialNumber);
    connectorStatus.delete(serialNumber);

    sendToBase44(serialNumber, msgStatus(0, "Unavailable", "WS Close " + code)).catch(() => {});
  });

  ws.on("error", (err) => {
    logWarn(`[WS] erro ${serialNumber}:`, String((err && err.message) || err));
  });
});

// ping watchdog
if (ENABLE_PING) {
  setInterval(() => {
    for (const [serial, ws] of clients.entries()) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {}

        clients.delete(serial);
        pendingCommands.delete(serial);
        stopStatusPoll(serial);
        stopMeterPullLoop(serial);
        txActive.delete(serial);

        for (const [id, meta] of pendingById.entries()) {
          if (meta.serialNumber === serial) pendingById.delete(id);
        }

        markOffline(serial, "Ping timeout");

        lastSeen.delete(serial);
        onlineState.delete(serial);
        base44OnlinePing.delete(serial);
        connectorStatus.delete(serial);
        continue;
      }

      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, PING_INTERVAL_MS);
}

// sweeper offline
setInterval(() => {
  for (const serial of clients.keys()) {
    if (!isOnline(serial)) {
      markOffline(serial, "No traffic for > " + ONLINE_TTL_SEC + "s");
    }
  }
}, ONLINE_SWEEP_SEC * 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("OCPP Gateway rodando na porta " + PORT);
  console.log("BASE44_URL=" + (BASE44_URL ? "[set]" : "[empty]"));
  console.log("BASE44_COMMAND_QUEUE_URL=" + (BASE44_COMMAND_QUEUE_URL ? "[set]" : "[empty]"));
  console.log("BASE44_COMMAND_STATUS_URL=" + (BASE44_COMMAND_STATUS_URL ? "[set]" : "[empty]"));
  console.log("COMMAND_POLL_ON_BOOT=" + COMMAND_POLL_ON_BOOT);
  console.log("COMMAND_POLL_ON_HEARTBEAT=" + COMMAND_POLL_ON_HEARTBEAT);
  console.log("COMMAND_POLL_MIN_INTERVAL_MS=" + COMMAND_POLL_MIN_INTERVAL_MS);
  console.log("BOOT_INTERVAL_SEC=" + BOOT_INTERVAL_SEC);
  console.log("BASE44_HEARTBEAT_SEC=" + BASE44_HEARTBEAT_SEC);
  console.log("ENABLE_PING=" + ENABLE_PING);
  console.log("TCP_KEEPALIVE_MS=" + TCP_KEEPALIVE_MS);
  console.log("ONLINE_TTL_SEC=" + ONLINE_TTL_SEC);
  console.log("ONLINE_SWEEP_SEC=" + ONLINE_SWEEP_SEC);
  console.log("BASE44_ONLINE_PING_SEC=" + BASE44_ONLINE_PING_SEC);
  console.log("AUTO_TRIGGER_STATUS=" + AUTO_TRIGGER_STATUS);
  console.log("AUTO_TRIGGER_METER=" + AUTO_TRIGGER_METER);
  console.log("METER_PULL_ENABLED=" + METER_PULL_ENABLED);
  console.log("METER_PULL_INTERVAL_MS=" + METER_PULL_INTERVAL_MS);
  console.log("LOG_PAYLOADS=" + LOG_PAYLOADS);
  console.log("LOG_HEARTBEAT=" + LOG_HEARTBEAT);
  console.log("COMMAND_PUSH_ENABLED=" + COMMAND_PUSH_ENABLED);
  console.log("BASE44_WEBHOOK_PATH=" + BASE44_WEBHOOK_PATH);
  console.log("BASE44_WEBHOOK_SECRET=" + (BASE44_WEBHOOK_SECRET ? "[set]" : "[empty]"));
});
