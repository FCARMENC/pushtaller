// api/check-resumen.js
// Cron: cada 20–30 min → https://pushtaller.vercel.app/api/check-resumen
// Header: Authorization: Bearer <CRON_SECRET>
// Prueba inmediata: ?test=1
// Env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON

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
function peruTimeHM(d) {
  const p = new Date(d.getTime() - 5 * 3600000);
  return String(p.getUTCHours()).padStart(2, "0") + ":" + String(p.getUTCMinutes()).padStart(2, "0");
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
  return admin.messaging().sendEachForMulticast({
    tokens: tokens,
    notification: { title: title, body: body },
    data: {
      title: String(title),
      body: String(body),
      tag: String(tag || "resumen"),
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
        tag: tag || "resumen",
      },
      fcmOptions: { link: APP_LINK },
    },
  });
}

const MOTIVATIONAL = [
  { title: "¡Sigue así! 💪", body: "Cada orden bien gestionada suma. Abre Expert y revisa qué toca hoy." },
  { title: "Tu taller, bajo control 🔧", body: "Un vistazo rápido a las órdenes puede ahorrarte tiempo después." },
  { title: "Pequeños pasos, grandes resultados", body: "Revisa el inventario o la agenda. Mantener el orden marca la diferencia." },
  { title: "Momento Expert ✨", body: "¿Hay algún vehículo listo para entregar? Entra y confírmalo." },
  { title: "Organización = menos estrés", body: "Actualiza el estado de una orden. Tus clientes lo notarán." },
  { title: "El taller no se detiene 🚗", body: "Revisa si alguien espera repuesto o una respuesta de proforma." },
  { title: "Hoy es buen día para avanzar", body: "Abre el Panel y mira el resumen. Todo en un solo lugar." },
  { title: "Calidad en cada detalle", body: "Una proforma clara o un acta de recepción bien hecha genera confianza." },
  { title: "Tu equipo cuenta contigo", body: "Si hay órdenes en diagnóstico, asígnalas y mantén el flujo." },
  { title: "Constancia que se nota 📈", body: "Lleva al día la caja y los abonos. El control financiero empieza aquí." },
  { title: "Clientes felices, taller fuerte", body: "¿Alguna orden lista? Notifica y entrega. Esa es la mejor publicidad." },
  { title: "Un minuto bien invertido", body: "Revisa stock bajo. Evitar quedarte sin repuestos te ahorra dolores de cabeza." },
  { title: "Profesionalismo en marcha", body: "Expert está listo cuando tú lo estés. Entra y sigue construyendo." },
  { title: "El orden se nota afuera", body: "Agenda, órdenes y caja al día = un taller que inspira confianza." },
  { title: "Sigue el ritmo 🎯", body: "Mira qué hay para hoy. Un plan claro hace más liviano el trabajo." },
];

function buildResumen(orders, parts, appointments, proformas, hoyKey) {
  orders = orders || [];
  parts = parts || [];
  appointments = appointments || [];
  proformas = proformas || [];
  const listos = orders.filter(function (o) { return o.status === "listo"; }).length;
  const espera = orders.filter(function (o) { return o.status === "espera_repuesto"; }).length;
  const bajoStock = parts.filter(function (p) {
    return p.stock <= (p.min != null ? p.min : 0);
  }).length;
  const citasHoy = appointments.filter(function (a) { return a.date === hoyKey; }).length;
  const pfPend = proformas.filter(function (p) { return p.status === "pendiente"; }).length;
  const activos = orders.filter(function (o) { return o.status !== "entregado"; }).length;
  const tips = [];
  if (listos > 0) tips.push(listos + " orden(es) lista(s) para entregar");
  if (espera > 0) tips.push(espera + " esperando repuesto");
  if (bajoStock > 0) tips.push(bajoStock + " repuesto(s) con stock bajo");
  if (citasHoy > 0) tips.push(citasHoy + " cita(s) hoy");
  if (pfPend > 0) tips.push(pfPend + " proforma(s) pendiente(s)");
  if (tips.length === 0 && activos > 0) tips.push(activos + " orden(es) activa(s) en el taller");
  if (tips.length === 0) return null;
  return { title: "Resumen del taller 📋", body: tips.slice(0, 3).join(" · ") };
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
    const hoyKey = peruDateKey(ahora);
    const horaPeru = peruTimeHM(ahora);

    let isTest = false;
    try {
      isTest = !!(req.query && (req.query.test === "1" || req.query.test === "true"));
    } catch (e) {}

    const [tokensSnap, settingsSnap] = await Promise.all([
      db.collection("tallerData").doc("expertTaller.fcmTokens").get(),
      db.collection("tallerData").doc("expertTaller.settings").get(),
    ]);

    const tokens = normalizeTokens((tokensSnap.exists && tokensSnap.data().value) || []);
    let settings = (settingsSnap.exists && settingsSnap.data().value) || {};
    const rd = settings.resumenDiario || {};

    if (isTest) {
      if (!tokens.length) {
        res.status(200).json({
          ok: true, modo: "test", enviado: false, tokens: 0,
          nota: "No hay dispositivos. Activa avisos en Expert y reinicia el registro.",
          horaPeru: horaPeru, fechaPeru: hoyKey,
        });
        return;
      }
      const pushRes = await sendPush(
        tokens,
        "✅ Prueba resumen Expert",
        "Si ves esto, los resúmenes automáticos funcionan. Tokens: " + tokens.length,
        "resumen-test"
      );
      res.status(200).json({
        ok: true, modo: "test", enviado: true, tokens: tokens.length,
        successCount: pushRes.successCount, failureCount: pushRes.failureCount,
        horaPeru: horaPeru, fechaPeru: hoyKey, resumenActivo: !!rd.activo,
      });
      return;
    }

    if (!rd.activo) {
      res.status(200).json({
        ok: true, enviado: false, motivo: "resumenDiario desactivado en Ajustes",
        tokens: tokens.length, horaPeru: horaPeru, fechaPeru: hoyKey,
      });
      return;
    }
    if (!tokens.length) {
      res.status(200).json({
        ok: true, enviado: false, motivo: "sin tokens", tokens: 0,
        horaPeru: horaPeru, fechaPeru: hoyKey,
      });
      return;
    }

    const inicio = rd.ventanaInicio || "08:00";
    const fin = rd.ventanaFin || "20:00";
    const maxPorDia = Number(rd.maxPorDia) || 4;
    const lastSentKeys = Array.isArray(rd.lastSentKeys) ? rd.lastSentKeys : [];
    const enviadosHoy = lastSentKeys.filter(function (k) {
      return String(k).indexOf(hoyKey) === 0;
    });

    // --- Resumen FIJO a las 18:00 (hora Perú), una vez al día ---
    const horaFija = (rd.horaFija || "18:00").slice(0, 5);
    const lastFijo = rd.lastFijoKey || "";
    let orders = [], parts = [], appointments = [], proformas = [];
    async function loadTallerData() {
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
    }

    if (horaPeru >= horaFija && lastFijo !== hoyKey) {
      await loadTallerData();
      const resumenFijo = buildResumen(orders, parts, appointments, proformas, hoyKey);
      const msgFijo = resumenFijo || {
        title: "Cierre del día 📋",
        body: "Fin de la jornada. Revisa órdenes, caja y lo pendiente para mañana en Expert.",
      };
      // Título fijo de las 6 PM
      msgFijo.title = "Resumen de las 6:00 p.m. 📋";
      const pushFijo = await sendPush(
        tokens,
        msgFijo.title,
        msgFijo.body,
        "resumen-fijo-" + hoyKey
      );
      settings = Object.assign({}, settings, {
        resumenDiario: Object.assign({}, rd, {
          activo: true,
          horaFija: horaFija,
          lastFijoKey: hoyKey,
          maxPorDia: maxPorDia,
          ventanaInicio: inicio,
          ventanaFin: fin,
          lastSentKeys: lastSentKeys,
        }),
      });
      await db.collection("tallerData").doc("expertTaller.settings").set({
        value: settings,
        updatedAt: Date.now(),
      });
      res.status(200).json({
        ok: true,
        enviado: true,
        tipo: "resumen-fijo-18h",
        title: msgFijo.title,
        body: msgFijo.body,
        tokens: tokens.length,
        successCount: pushFijo.successCount,
        failureCount: pushFijo.failureCount,
        horaPeru: horaPeru,
        fechaPeru: hoyKey,
      });
      return;
    }

    // --- Tips aleatorios en ventana (opcional, no reemplaza el de las 18:00) ---
    if (horaPeru < inicio || horaPeru > fin) {
      res.status(200).json({
        ok: true, enviado: false,
        motivo: "fuera de ventana " + inicio + "-" + fin,
        horaPeru: horaPeru, tokens: tokens.length,
        proximoFijo: horaFija, fijoHoy: lastFijo === hoyKey,
      });
      return;
    }
    if (enviadosHoy.length >= maxPorDia) {
      res.status(200).json({
        ok: true, enviado: false,
        motivo: "ya se enviaron " + maxPorDia + " tips hoy",
        enviadosHoy: enviadosHoy.length, horaPeru: horaPeru, tokens: tokens.length,
      });
      return;
    }
    if (Math.random() >= 0.35) {
      res.status(200).json({
        ok: true, enviado: false, motivo: "esta corrida no tocó (aleatorio)",
        enviadosHoy: enviadosHoy.length, horaPeru: horaPeru, tokens: tokens.length,
        proximoFijo: horaFija, fijoHoy: lastFijo === hoyKey,
      });
      return;
    }

    await loadTallerData();
    const resumen = buildResumen(orders, parts, appointments, proformas, hoyKey);
    const msg = resumen || MOTIVATIONAL[Math.floor(Math.random() * MOTIVATIONAL.length)];
    const tag = "resumen-diario-" + hoyKey + "-" + horaPeru.replace(":", "");

    const pushRes = await sendPush(tokens, msg.title, msg.body, tag);

    const nuevaKey = hoyKey + "-" + horaPeru;
    settings = Object.assign({}, settings, {
      resumenDiario: {
        activo: true,
        maxPorDia: maxPorDia,
        ventanaInicio: inicio,
        ventanaFin: fin,
        horaFija: horaFija,
        lastFijoKey: lastFijo,
        lastSentKeys: enviadosHoy.concat([nuevaKey]).slice(-12),
      },
    });
    await db.collection("tallerData").doc("expertTaller.settings").set({
      value: settings,
      updatedAt: Date.now(),
    });

    res.status(200).json({
      ok: true, enviado: true,
      tipo: resumen ? "resumen" : "motivador",
      title: msg.title,
      tokens: tokens.length,
      successCount: pushRes.successCount,
      failureCount: pushRes.failureCount,
      enviadosHoy: enviadosHoy.length + 1,
      horaPeru: horaPeru,
      fechaPeru: hoyKey,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error interno" });
  }
};
