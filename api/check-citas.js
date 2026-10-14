// api/check-citas.js
// -----------------------------------------------------------------------------
// DEBE llamarse desde cron-job.org cada 5–10 minutos:
//   URL:    https://pushtaller.vercel.app/api/check-citas
//   Header: Authorization: Bearer <CRON_SECRET>
//
// Pruebas manuales (mismo header):
//   ?force=recordatorio  → manda YA el aviso del equipo (ignora hora y lastSent)
//   ?force=resumen       → manda YA el resumen de las 6 PM
//   ?diag=1              → no envía; solo reporta estado
//
// Env Vercel: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON
// -----------------------------------------------------------------------------

const admin = require("firebase-admin");

const APP_LINK = "https://fcarmenc.github.io/tallerpro/";
const ICON = process.env.NOTIFY_ICON_URL || "https://fcarmenc.github.io/tallerpro/icon-192.png";
const BADGE = process.env.NOTIFY_BADGE_URL || "https://fcarmenc.github.io/tallerpro/badge-72.png";

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

/** Fecha YYYY-MM-DD en hora Perú (UTC-5 fijo) */
function peruDateKey(d) {
  return new Date(d.getTime() - 5 * 3600000).toISOString().slice(0, 10);
}

/** HH:MM en hora Perú */
function peruTimeHM(d) {
  const p = new Date(d.getTime() - 5 * 3600000);
  return (
    String(p.getUTCHours()).padStart(2, "0") +
    ":" +
    String(p.getUTCMinutes()).padStart(2, "0")
  );
}

/** Normaliza "8:00", "08:00", "8:00 a.m." → "08:00" */
function normalizeHora(h) {
  if (!h) return "08:00";
  const s = String(h).trim().toLowerCase();
  const m = s.match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (!m) return "08:00";
  let hh = parseInt(m[1], 10);
  const mm = m[2];
  if (s.indexOf("p.m") !== -1 || s.indexOf("pm") !== -1) {
    if (hh < 12) hh += 12;
  }
  if ((s.indexOf("a.m") !== -1 || s.indexOf("am") !== -1) && hh === 12) hh = 0;
  return String(hh).padStart(2, "0") + ":" + mm;
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
  if (!tokens.length) return { successCount: 0, failureCount: 0, responses: [] };
  return admin.messaging().sendEachForMulticast({
    tokens: tokens,
    notification: { title: title, body: body },
    data: {
      title: String(title),
      body: String(body),
      tag: String(tag || "expert"),
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
        tag: tag || "expert",
      },
      fcmOptions: { link: APP_LINK },
    },
  });
}

async function buildResumenBody(db, hoyKey) {
  let orders = [], parts = [], appointments = [], proformas = [];
  try {
    const snaps = await Promise.all([
      db.collection("tallerData").doc("expertTaller.orders").get(),
      db.collection("tallerData").doc("expertTaller.parts").get(),
      db.collection("tallerData").doc("expertTaller.appointments").get(),
      db.collection("tallerData").doc("expertTaller.proformas").get(),
    ]);
    orders = (snaps[0].exists && snaps[0].data().value) || [];
    parts = (snaps[1].exists && snaps[1].data().value) || [];
    appointments = (snaps[2].exists && snaps[2].data().value) || [];
    proformas = (snaps[3].exists && snaps[3].data().value) || [];
  } catch (e) {}

  const listos = orders.filter(function (o) { return o && o.status === "listo"; }).length;
  const espera = orders.filter(function (o) { return o && o.status === "espera_repuesto"; }).length;
  const bajoStock = parts.filter(function (p) {
    return p && p.stock <= (p.min != null ? p.min : 0);
  }).length;
  const citasHoy = appointments.filter(function (a) { return a && a.date === hoyKey; }).length;
  const pfPend = proformas.filter(function (p) { return p && p.status === "pendiente"; }).length;
  const activos = orders.filter(function (o) { return o && o.status !== "entregado"; }).length;

  const tips = [];
  if (listos > 0) tips.push(listos + " lista(s) para entregar");
  if (espera > 0) tips.push(espera + " esperando repuesto");
  if (bajoStock > 0) tips.push(bajoStock + " con stock bajo");
  if (citasHoy > 0) tips.push(citasHoy + " cita(s) hoy");
  if (pfPend > 0) tips.push(pfPend + " proforma(s) pendiente(s)");
  if (tips.length === 0 && activos > 0) tips.push(activos + " orden(es) activa(s)");

  if (tips.length > 0) return tips.slice(0, 3).join(" · ");
  return "Fin de la jornada. Revisa lo pendiente y deja el taller listo para mañana.";
}

module.exports = async function (req, res) {
  const auth = req.headers.authorization || "";
  if (process.env.CRON_SECRET && auth !== "Bearer " + process.env.CRON_SECRET) {
    res.status(401).json({ error: "No autorizado", hint: "Header Authorization: Bearer CRON_SECRET" });
    return;
  }

  const q = req.query || {};
  const force = String(q.force || "");
  const diagOnly = q.diag === "1" || q.diag === "true";

  try {
    getAdminApp();
    const db = admin.firestore();
    const ahora = new Date();
    const hoyKey = peruDateKey(ahora);
    const horaPeru = peruTimeHM(ahora);

    const [tokensSnap, settingsSnap, apptSnap] = await Promise.all([
      db.collection("tallerData").doc("expertTaller.fcmTokens").get(),
      db.collection("tallerData").doc("expertTaller.settings").get(),
      db.collection("tallerData").doc("expertTaller.appointments").get(),
    ]);

    const tokens = normalizeTokens((tokensSnap.exists && tokensSnap.data().value) || []);
    const settings = (settingsSnap.exists && settingsSnap.data().value) || {};
    let citas = (apptSnap.exists && apptSnap.data().value) || [];
    if (!Array.isArray(citas)) citas = [];

    const recordatorio = settings.recordatorioEquipo || {};
    const rd = settings.resumenDiario || {};
    const horaRecordatorio = normalizeHora(recordatorio.hora || "08:00");
    const horaFija = normalizeHora(rd.horaFija || "18:00");

    const diag = {
      horaPeru: horaPeru,
      fechaPeru: hoyKey,
      tokens: tokens.length,
      recordatorio: {
        activo: !!recordatorio.activo,
        hora: horaRecordatorio,
        lastSentKey: recordatorio.lastSentKey || null,
        yaEnviadoHoy: recordatorio.lastSentKey === hoyKey,
        mensaje: (recordatorio.mensaje || "").slice(0, 80),
      },
      resumenFijo: {
        hora: horaFija,
        lastFijoKey: rd.lastFijoKey || null,
        yaEnviadoHoy: rd.lastFijoKey === hoyKey,
      },
      force: force || null,
    };

    if (diagOnly) {
      res.status(200).json({ ok: true, modo: "diag", ...diag });
      return;
    }

    let settingsOut = Object.assign({}, settings);
    let settingsDirty = false;
    let avisosCitas = 0;
    let recordatorioEnviado = false;
    let resumenFijoEnviado = false;
    let pushResults = [];

    // ----- 1. Citas (solo si no es force) -----
    if (!force) {
      const minutosAntes = Number(
        settings.citaAvisoMinutos != null ? settings.citaAvisoMinutos : 30
      );
      const avisos = [];
      const citasActualizadas = citas.map(function (cita) {
        if (!cita || !cita.date || !cita.time) return cita;
        if (cita.status === "cancelada" || cita.status === "completada") return cita;
        const horaCita = normalizeHora(cita.time);
        const inicio = new Date(cita.date + "T" + horaCita + ":00-05:00");
        if (isNaN(inicio.getTime())) return cita;
        const minutosParaEmpezar = (inicio.getTime() - ahora.getTime()) / 60000;
        let actualizada = cita;
        if (
          minutosAntes > 0 &&
          !cita.notifiedAntes &&
          minutosParaEmpezar > 0 &&
          minutosParaEmpezar <= minutosAntes
        ) {
          avisos.push({ ...cita, _tipo: "antes", _min: Math.round(minutosParaEmpezar) });
          actualizada = { ...actualizada, notifiedAntes: true };
        }
        if (!cita.notified && minutosParaEmpezar <= 0 && minutosParaEmpezar >= -15) {
          avisos.push({ ...cita, _tipo: "ahora" });
          actualizada = { ...actualizada, notified: true };
        }
        return actualizada;
      });

      if (avisos.length && tokens.length) {
        for (const cita of avisos) {
          const title =
            cita._tipo === "antes"
              ? "⏰ Cita en " + cita._min + " min: " + (cita.client || "Cliente")
              : "🔔 Cita ahora: " + (cita.client || "Cliente");
          const body =
            (cita.service || "Servicio") +
            (cita.vehicle ? " · " + cita.vehicle : "") +
            " · " +
            cita.time;
          const pr = await sendPush(tokens, title, body, "cita-" + cita.id + "-" + cita._tipo);
          pushResults.push({ tipo: "cita", success: pr.successCount, fail: pr.failureCount });
        }
        avisosCitas = avisos.length;
        await db.collection("tallerData").doc("expertTaller.appointments").set({
          value: citasActualizadas,
          updatedAt: Date.now(),
        });
      }
    }

    // ----- 2. Recordatorio del equipo -----
    const debeRecordatorio =
      force === "recordatorio" ||
      (recordatorio.activo &&
        horaPeru >= horaRecordatorio &&
        recordatorio.lastSentKey !== hoyKey);

    if (debeRecordatorio) {
      if (!tokens.length) {
        diag.recordatorio.motivo = "sin tokens";
      } else {
        const pr = await sendPush(
          tokens,
          "📢 Aviso del taller",
          recordatorio.mensaje ||
            "No olvides registrar las órdenes y movimientos de hoy en el sistema 💪",
          "recordatorio-equipo-" + hoyKey
        );
        pushResults.push({
          tipo: "recordatorio",
          success: pr.successCount,
          fail: pr.failureCount,
        });
        settingsOut.recordatorioEquipo = Object.assign({}, recordatorio, {
          activo: true,
          hora: horaRecordatorio,
          lastSentKey: hoyKey,
        });
        settingsDirty = true;
        recordatorioEnviado = true;
      }
    } else if (recordatorio.activo) {
      if (recordatorio.lastSentKey === hoyKey) diag.recordatorio.motivo = "ya enviado hoy";
      else if (horaPeru < horaRecordatorio) diag.recordatorio.motivo = "aún no es la hora (" + horaRecordatorio + ")";
      else diag.recordatorio.motivo = "no aplica";
    } else {
      diag.recordatorio.motivo = "desactivado en la app";
    }

    // ----- 3. Resumen fijo 18:00 -----
    const debeResumen =
      force === "resumen" ||
      (horaPeru >= horaFija && rd.lastFijoKey !== hoyKey);

    if (debeResumen) {
      if (!tokens.length) {
        diag.resumenFijo.motivo = "sin tokens";
      } else {
        const body = await buildResumenBody(db, hoyKey);
        const pr = await sendPush(
          tokens,
          "Resumen de las 6:00 p.m. 📋",
          body,
          "resumen-fijo-" + hoyKey
        );
        pushResults.push({
          tipo: "resumen-fijo",
          success: pr.successCount,
          fail: pr.failureCount,
        });
        settingsOut.resumenDiario = Object.assign({}, rd, {
          horaFija: horaFija,
          lastFijoKey: hoyKey,
          activo: rd.activo !== false,
        });
        settingsDirty = true;
        resumenFijoEnviado = true;
      }
    } else {
      if (rd.lastFijoKey === hoyKey) diag.resumenFijo.motivo = "ya enviado hoy";
      else if (horaPeru < horaFija) diag.resumenFijo.motivo = "aún no es la hora (" + horaFija + ")";
      else diag.resumenFijo.motivo = "no aplica";
    }

    if (settingsDirty) {
      await db.collection("tallerData").doc("expertTaller.settings").set({
        value: settingsOut,
        updatedAt: Date.now(),
      });
    }

    res.status(200).json({
      ok: true,
      avisosCitas: avisosCitas,
      recordatorioEquipo: recordatorioEnviado,
      resumenFijo18h: resumenFijoEnviado,
      tokens: tokens.length,
      horaPeru: horaPeru,
      fechaPeru: hoyKey,
      pushResults: pushResults,
      diag: diag,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error interno" });
  }
};
