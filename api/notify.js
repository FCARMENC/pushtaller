// Vercel: api/notify.js  →  POST https://pushtaller.vercel.app/api/notify
// Env: NOTIFY_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON
//
// CORS: la app vive en GitHub Pages (fcarmenc.github.io) y llama a este dominio.

const admin = require("firebase-admin");

const ALLOWED_ORIGINS = [
  "https://fcarmenc.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function corsHeaders(origin) {
  const allow =
    origin && ALLOWED_ORIGINS.some(function (o) {
      return origin === o || origin.indexOf("https://fcarmenc.github.io") === 0;
    })
      ? origin
      : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
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

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  const headers = corsHeaders(origin);
  Object.keys(headers).forEach(function (k) {
    res.setHeader(k, headers[k]);
  });

  // Preflight del navegador (sin esto sale "Failed to fetch")
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (!body.secret || body.secret !== process.env.NOTIFY_SECRET) {
      res.status(401).json({ error: "Secreto inválido" });
      return;
    }

    const title = String(body.title || "Expert").slice(0, 120);
    const msgBody = String(body.body || "").slice(0, 500);
    const tag = String(body.tag || "aviso-equipo").slice(0, 64);
    const icon = process.env.NOTIFY_ICON_URL || "https://pushtaller.vercel.app/icon-192.png";
    const badge = process.env.NOTIFY_BADGE_URL || "https://pushtaller.vercel.app/badge-72.png";

    getAdminApp();
    const db = admin.firestore();
    const snap = await db.collection("tallerData").doc("expertTaller.fcmTokens").get();
    const tokens = normalizeTokens((snap.exists && snap.data().value) || []);

    if (!tokens.length) {
      res.status(200).json({ ok: true, sent: 0, failed: 0, note: "Sin dispositivos registrados" });
      return;
    }

    const pushRes = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: { title: title, body: msgBody },
      data: { title: title, body: msgBody, tag: tag, icon: icon, badge: badge },
      webpush: {
        headers: { Urgency: "high" },
        notification: { title: title, body: msgBody, icon: icon, badge: badge, tag: tag },
        fcmOptions: { link: "https://fcarmenc.github.io/tallerpro/" },
      },
    });

    const invalid = [];
    (pushRes.responses || []).forEach(function (r, i) {
      if (r.success) return;
      const code = r.error && r.error.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        invalid.push(tokens[i]);
      }
    });
    if (invalid.length) {
      const next = tokens.filter(function (t) {
        return invalid.indexOf(t) === -1;
      });
      await db.collection("tallerData").doc("expertTaller.fcmTokens").set(
        { value: next, updatedAt: Date.now() },
        { merge: true }
      );
    }

    res.status(200).json({
      ok: true,
      sent: pushRes.successCount || 0,
      failed: pushRes.failureCount || 0,
      tokens: tokens.length,
      cleaned: invalid.length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e && e.message) || "Error interno" });
  }
};
