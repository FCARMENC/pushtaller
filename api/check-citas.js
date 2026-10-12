// api/check-citas.js
// Cron: cada 5–10 min → https://pushtaller.vercel.app/api/check-citas
// Header: Authorization: Bearer <CRON_SECRET>
// Env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON
//
// 1) Avisos de citas (antes / ahora)
// 2) Recordatorio diario al equipo (hora en Ajustes → Avisos)

const admin = require("firebase-admin");

const APP_LINK = "https://fcarmenc.github.io/tallerpro/";
const ICON = process.env.NOTIFY_ICON_URL || "https://pushtaller.vercel.app/icon-192.png";
const BADGE = process.env.NOTIFY_BADGE_URL || "https://pushtaller.vercel.app/badge-72.png";

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function peruDateKey(d) {
  return new Date(d.getTime() - 5 * 3600000).toISOString().slice(0, 10);
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

async function sendPush(tokens, title, body, tag) {
  if (!tokens.length) return { successCount: 0, failureCount: 0 };
  return admin.messaging().sendEachForMulticast({
    tokens: tokens,
    notification: { title: title, body: body },
    data: {
      title: String(title),
      body: String(body),
      tag: String(tag || "cita"),
      icon: ICON,
      badge: BADGE,
    },
    webpush: {
      headers: { Urgency: "high" },
      notification: {
        title: title,
        body: body,
        icon: ICON,
        badge: BADGE,
        tag: tag || "cita",
      },
      fcmOptions: { link: APP_LINK },
    },
  });
}

module.exports = async function (req, res) {
  const auth = req.headers.authorization || "";
  if (process.env.CRON_SECRET && auth !== "Bearer " + process.env.CRON_SECRET) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }

  try {
    getAdminApp();
    const db = admin.firestore();
    const ahora = new Date();

    const [tokensSnap, settingsSnap, apptSnap] = await Promise.all([
      db.collection("tallerData").doc("expertTaller.fcmTokens").get(),
      db.collection("tallerData").doc("expertTaller.settings").get(),
      db.collection("tallerData").doc("expertTaller.appointments").get(),
    ]);

    const tokens = normalizeTokens((tokensSnap.exists && tokensSnap.data().value) || []);
    const settings = (settingsSnap.exists && settingsSnap.data().value) || {};
    let citas = (apptSnap.exists && apptSnap.data().value) || [];
    if (!Array.isArray(citas)) citas = [];

    const minutosAntes = Number((settings.citaAvisoMinutos != null ? settings.citaAvisoMinutos : 30));

    // --- 1. Citas ---
    const avisosCitas = [];
    const citasActualizadas = citas.map(function (cita) {
      if (!cita || !cita.date || !cita.time) return cita;
      if (cita.status === "cancelada" || cita.status === "completada") return cita;

      const inicio = new Date(cita.date + "T" + cita.time + ":00-05:00");
      if (isNaN(inicio.getTime())) return cita;
      const minutosParaEmpezar = (inicio.getTime() - ahora.getTime()) / 60000;
      let actualizada = cita;

      if (
        minutosAntes > 0 &&
        !cita.notifiedAntes &&
        minutosParaEmpezar > 0 &&
        minutosParaEmpezar <= minutosAntes
      ) {
        avisosCitas.push({ ...cita, _tipo: "antes", _min: Math.round(minutosParaEmpezar) });
        actualizada = { ...actualizada, notifiedAntes: true };
      }
      if (!cita.notified && minutosParaEmpezar <= 0 && minutosParaEmpezar >= -15) {
        avisosCitas.push({ ...cita, _tipo: "ahora" });
        actualizada = { ...actualizada, notified: true };
      }
      return actualizada;
    });

    if (avisosCitas.length && tokens.length) {
      for (const cita of avisosCitas) {
        const title =
          cita._tipo === "antes"
            ? "⏰ Cita en " + cita._min + " min: " + (cita.client || "Cliente")
            : "🔔 Cita ahora: " + (cita.client || "Cliente");
        const body =
          (cita.service || "Servicio") +
          (cita.vehicle ? " · " + cita.vehicle : "") +
          " · " +
          cita.time;
        await sendPush(tokens, title, body, "cita-" + cita.id + "-" + cita._tipo);
      }
    }

    if (avisosCitas.length) {
      await db.collection("tallerData").doc("expertTaller.appointments").set({
        value: citasActualizadas,
        updatedAt: Date.now(),
      });
    }

    // --- 2. Recordatorio diario al equipo ---
    let recordatorioEnviado = false;
    const recordatorio = settings.recordatorioEquipo;
    if (recordatorio && recordatorio.activo) {
      const hoyKey = peruDateKey(ahora);
      const hora = recordatorio.hora || "08:00";
      const objetivoHoy = new Date(hoyKey + "T" + hora + ":00-05:00");
      if (ahora.getTime() >= objetivoHoy.getTime() && recordatorio.lastSentKey !== hoyKey) {
        if (tokens.length) {
          await sendPush(
            tokens,
            "📢 Aviso del taller",
            recordatorio.mensaje ||
              "No olvides registrar las órdenes y movimientos de hoy en el sistema 💪",
            "recordatorio-equipo-" + hoyKey
          );
        }
        await db.collection("tallerData").doc("expertTaller.settings").set({
          value: {
            ...settings,
            recordatorioEquipo: { ...recordatorio, lastSentKey: hoyKey },
          },
          updatedAt: Date.now(),
        });
        recordatorioEnviado = true;
      }
    }

    res.status(200).json({
      ok: true,
      avisosCitas: avisosCitas.length,
      recordatorioEquipo: recordatorioEnviado,
      tokens: tokens.length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error interno" });
  }
};
