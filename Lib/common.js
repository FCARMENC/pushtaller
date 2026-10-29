// lib/common.js — utilidades compartidas de las funciones de avisos.
const admin = require("firebase-admin");

const ALLOWED_ORIGINS = [
  "https://fcarmenc.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

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

// Envía a todos los dispositivos registrados y limpia los tokens que ya no sirven.
async function sendToAll(title, body, tag) {
  getAdminApp();
  const db = admin.firestore();
  const ICON = process.env.NOTIFY_ICON_URL || "https://fcarmenc.github.io/tallerpro/icon-192.png";
  const BADGE = process.env.NOTIFY_BADGE_URL || "https://fcarmenc.github.io/tallerpro/badge-72.png";
  const ref = db.collection("tallerData").doc("expertTaller.fcmTokens");
  const snap = await ref.get();
  const tokens = normalizeTokens((snap.exists && snap.data().value) || []);
  if (!tokens.length) return { ok: true, sent: 0, failed: 0, tokens: 0, cleaned: 0, note: "Sin dispositivos registrados" };

  const pushRes = await admin.messaging().sendEachForMulticast({
    tokens: tokens,
    notification: { title: title, body: body },
    data: { title: title, body: body, tag: tag, icon: ICON, badge: BADGE },
    webpush: {
      headers: { Urgency: "high" },
      notification: { title: title, body: body, icon: ICON, badge: BADGE, tag: tag },
      fcmOptions: { link: "https://fcarmenc.github.io/tallerpro/" },
    },
  });

  const invalid = [];
  (pushRes.responses || []).forEach(function (r, i) {
    if (r.success) return;
    const code = r.error && r.error.code;
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
      invalid.push(tokens[i]);
    }
  });
  if (invalid.length) {
    const next = tokens.filter(function (t) { return invalid.indexOf(t) === -1; });
    await ref.set({ value: next, updatedAt: Date.now() }, { merge: true });
  }
  return { ok: true, sent: pushRes.successCount || 0, failed: pushRes.failureCount || 0, tokens: tokens.length, cleaned: invalid.length };
}

module.exports = { admin, applyCors, getAdminApp, normalizeTokens, parseBody, clean, requireStaff, sendToAll };
