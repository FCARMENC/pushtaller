// lib/common.js — utilidades compartidas de las funciones de avisos.
const admin = require("firebase-admin");

const ALLOWED_ORIGINS = [
  "https://fcarmenc.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

// Documentos en tallerData que usan los avisos:
//  - expertTaller.fcmTokens   → lista de tokens (formato antiguo, se sigue leyendo).
//  - expertTaller.fcmDevices  → { devices: { [token]: { usuario, rolId, plataforma, actualizado } } }
//  - pushLog_<fecha>_<rnd>    → un documento por envío (historial para revisar sin Vercel).
const TOKENS_DOC = "expertTaller.fcmTokens";
const DEVICES_DOC = "expertTaller.fcmDevices";
const LOG_PREFIX = "pushLog_";

function applyCors(req, res) {
  const origin = (req.headers && req.headers.origin) || "";
  // Coincidencia EXACTA (antes se aceptaba cualquier dominio que empezara igual).
  const allow = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  return admin.initializeApp({ credential: admin.credential.cert(sa) });
}

function normalizeTokens(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(function (t) {
      if (typeof t === "string") return t;
      if (t && typeof t.token === "string") return t.token;
      return null;
    })
    .filter(Boolean);
}

function parseBody(req) {
  try {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch (e) {
    return {};
  }
}

// Quita caracteres de control y recorta (el texto del aviso nunca viene "crudo" del navegador).
function clean(v, max) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

// Solo el equipo del taller (cuenta con correo y contraseña) puede pedir avisos libres.
async function requireStaff(req) {
  const h = (req.headers && req.headers.authorization) || "";
  const m = h.match(/^Bearer (.+)$/);
  if (!m) throw new Error("sin-sesion");
  getAdminApp();
  const decoded = await admin.auth().verifyIdToken(m[1]);
  if (!decoded.firebase || decoded.firebase.sign_in_provider !== "password") throw new Error("no-es-equipo");
  return decoded;
}

// Códigos de FCM que suelen ser temporales: se reintentan una vez antes de darlos por fallidos.
const TRANSIENT_CODES = [
  "messaging/internal-error",
  "messaging/server-unavailable",
  "messaging/unknown-error",
];
// Tokens que ya no sirven (el teléfono desinstaló la app o revocó el permiso): se borran.
const INVALID_CODES = [
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
];

async function loadDevices(db) {
  const snap = await db.collection("tallerData").doc(DEVICES_DOC).get();
  return (snap.exists && snap.data().devices) || {};
}

// Envía a los dispositivos registrados.
//   opts.roles: array de ids de rol → solo a los dispositivos de esos roles (los tokens antiguos
//               sin rol registrado no reciben avisos dirigidos).
// Un solo camino de visualización: el mensaje va solo como "data" y el service worker de la app
// lo muestra (así no sale duplicado). Reintenta una vez errores temporales, limpia tokens muertos
// con arrayRemove (sin pisar a otros dispositivos) y deja un registro en pushLog_*.
async function sendToAll(title, body, tag, opts) {
  opts = opts || {};
  getAdminApp();
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;
  const ICON = process.env.NOTIFY_ICON_URL || "https://fcarmenc.github.io/tallerpro/icon-192.png";
  const BADGE = process.env.NOTIFY_BADGE_URL || "https://fcarmenc.github.io/tallerpro/badge-72.png";
  const tokensRef = db.collection("tallerData").doc(TOKENS_DOC);
  const devicesRef = db.collection("tallerData").doc(DEVICES_DOC);

  const [snap, devices] = await Promise.all([tokensRef.get(), loadDevices(db)]);
  let tokens = normalizeTokens((snap.exists && snap.data().value) || []);
  const roles = Array.isArray(opts.roles) && opts.roles.length ? opts.roles : null;
  if (roles) {
    tokens = tokens.filter(function (t) {
      return devices[t] && roles.indexOf(devices[t].rolId) !== -1;
    });
  }

  const result = { ok: true, sent: 0, failed: 0, tokens: tokens.length, cleaned: 0, roles: roles };
  if (!tokens.length) {
    result.note = roles ? "Ningún dispositivo de ese rol está registrado" : "Sin dispositivos registrados";
    return result;
  }

  const message = {
    data: { title: title, body: body, tag: tag, icon: ICON, badge: BADGE },
    webpush: {
      headers: { Urgency: "high", TTL: "86400" },
      fcmOptions: { link: "https://fcarmenc.github.io/tallerpro/" },
    },
    android: { priority: "high" },
  };

  let pending = tokens.slice();
  let sent = 0;
  const failedFinal = [];
  const invalid = [];
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    const res = await admin.messaging().sendEachForMulticast(Object.assign({ tokens: pending }, message));
    const retry = [];
    (res.responses || []).forEach(function (r, i) {
      if (r.success) {
        sent++;
        return;
      }
      const code = r.error && r.error.code;
      if (INVALID_CODES.indexOf(code) !== -1) invalid.push(pending[i]);
      else if (TRANSIENT_CODES.indexOf(code) !== -1 && attempt === 0) retry.push(pending[i]);
      else failedFinal.push(pending[i]);
    });
    pending = retry;
    if (pending.length) await new Promise(function (resolve) { setTimeout(resolve, 2000); });
  }

  if (invalid.length) {
    const now = Date.now();
    await tokensRef.update({ value: FieldValue.arrayRemove(...invalid), updatedAt: now }).catch(function () {});
    const upd = {};
    invalid.forEach(function (t) { upd["devices." + t] = FieldValue.delete(); });
    await devicesRef.update(upd).catch(function () {});
  }

  result.sent = sent;
  result.failed = failedFinal.length + invalid.length;
  result.cleaned = invalid.length;

  const logId = LOG_PREFIX + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  await db.collection("tallerData").doc(logId).set({
    title: title,
    body: body,
    tag: tag,
    roles: roles,
    sent: sent,
    failed: result.failed,
    tokens: tokens.length,
    cleaned: invalid.length,
    at: Date.now(),
  }).catch(function () {});
  return result;
}

module.exports = { admin, applyCors, getAdminApp, normalizeTokens, parseBody, clean, requireStaff, sendToAll, DEVICES_DOC, TOKENS_DOC };
