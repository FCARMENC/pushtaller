// api/check-resumen.js
// -----------------------------------------------------------------------------
// Cron job INDEPENDIENTE de check-citas.js.
// Envía resúmenes del taller o mensajes motivadores a todos los dispositivos
// con push activado, incluso con la app cerrada.
//
// Configuración en la app Expert:
//   Ajustes → Resúmenes y tips del día (activo, ventana 08:00–20:00, máx 4/día)
//   Se guarda en Firestore: tallerData/expertTaller.settings → resumenDiario
//
// En cron-job.org crea un job NUEVO que llame cada 15–30 min a:
//   https://pushtaller.vercel.app/api/check-resumen
// Con header: Authorization: Bearer <CRON_SECRET>
// -----------------------------------------------------------------------------
const admin = require("firebase-admin");

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// Perú UTC-5 todo el año
function peruDateKey(d) {
  return new Date(d.getTime() - 5 * 3600000).toISOString().slice(0, 10);
}

function peruTimeHM(d) {
  const p = new Date(d.getTime() - 5 * 3600000);
  const hh = String(p.getUTCHours()).padStart(2, "0");
  const mm = String(p.getUTCMinutes()).padStart(2, "0");
  return hh + ":" + mm;
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
  if (tips.length === 0 && activos > 0) {
    tips.push(activos + " orden(es) activa(s) en el taller");
  }

  if (tips.length === 0) return null;
  return {
    title: "Resumen del taller 📋",
    body: tips.slice(0, 3).join(" · "),
  };
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

    // Modo prueba: /api/check-resumen?test=1  → manda un push YA
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
          ok: true,
          modo: "test",
          enviado: false,
          tokens: 0,
          nota: "No hay dispositivos registrados. Activa avisos en la app Expert.",
          horaPeru: horaPeru,
          fechaPeru: hoyKey,
        });
        return;
      }
      const testMsg = {
        title: "✅ Prueba resumen Expert",
        body: "Si ves esto, el cron de resúmenes funciona. Tokens: " + tokens.length,
      };
      const pushRes = await admin.messaging().sendEachForMulticast({
        tokens: tokens,
        notification: testMsg,
        data: { tag: "resumen-test" },
        webpush: { fcmOptions: { link: "/" } },
      });
      res.status(200).json({
        ok: true,
        modo: "test",
        enviado: true,
        tokens: tokens.length,
        successCount: pushRes.successCount,
        failureCount: pushRes.failureCount,
        horaPeru: horaPeru,
        fechaPeru: hoyKey,
        resumenActivo: !!rd.activo,
      });
      return;
    }

    // Sin modo test: solo si está activo en Ajustes
    if (!rd.activo) {
      res.status(200).json({
        ok: true,
        enviado: false,
        motivo: "resumenDiario desactivado en Ajustes",
        tokens: tokens.length,
        horaPeru: horaPeru,
        fechaPeru: hoyKey,
      });
      return;
    }

    if (!tokens.length) {
      res.status(200).json({
        ok: true,
        enviado: false,
        motivo: "sin tokens",
        tokens: 0,
        horaPeru: horaPeru,
        fechaPeru: hoyKey,
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

    if (horaPeru < inicio || horaPeru > fin) {
      res.status(200).json({
        ok: true,
        enviado: false,
        motivo: "fuera de ventana " + inicio + "-" + fin,
        horaPeru: horaPeru,
        tokens: tokens.length,
      });
      return;
    }

    if (enviadosHoy.length >= maxPorDia) {
      res.status(200).json({
        ok: true,
        enviado: false,
        motivo: "ya se enviaron " + maxPorDia + " hoy",
        enviadosHoy: enviadosHoy.length,
        horaPeru: horaPeru,
        tokens: tokens.length,
      });
      return;
    }

    // Probabilidad ~30% por corrida (si el cron corre cada 20–30 min ≈ varios al día)
    if (Math.random() >= 0.3) {
      res.status(200).json({
        ok: true,
        enviado: false,
        motivo: "esta corrida no tocó (aleatorio)",
        enviadosHoy: enviadosHoy.length,
        horaPeru: horaPeru,
        tokens: tokens.length,
      });
      return;
    }

    // Leer datos del taller para armar resumen
    let orders = [];
    let parts = [];
    let appointments = [];
    let proformas = [];
    try {
      const [ordersSnap, partsSnap, apptSnap, pfSnap] = await Promise.all([
        db.collection("tallerData").doc("expertTaller.orders").get(),
        db.collection("tallerData").doc("expertTaller.parts").get(),
        db.collection("tallerData").doc("expertTaller.appointments").get(),
        db.collection("tallerData").doc("expertTaller.proformas").get(),
      ]);
      orders = (ordersSnap.exists && ordersSnap.data().value) || [];
      parts = (partsSnap.exists && partsSnap.data().value) || [];
      appointments = (apptSnap.exists && apptSnap.data().value) || [];
      proformas = (pfSnap.exists && pfSnap.data().value) || [];
    } catch (e) {
      // Si falla la lectura, igual mandamos motivador
    }

    const resumen = buildResumen(orders, parts, appointments, proformas, hoyKey);
    const msg = resumen || MOTIVATIONAL[Math.floor(Math.random() * MOTIVATIONAL.length)];

    const pushRes = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: { title: msg.title, body: msg.body },
      data: { tag: "resumen-diario-" + hoyKey + "-" + horaPeru },
      webpush: { fcmOptions: { link: "/" } },
    });

    const nuevaKey = hoyKey + "-" + horaPeru;
    const nuevasKeys = enviadosHoy.concat([nuevaKey]).slice(-12);
    settings = Object.assign({}, settings, {
      resumenDiario: {
        activo: true,
        maxPorDia: maxPorDia,
        ventanaInicio: inicio,
        ventanaFin: fin,
        lastSentKeys: nuevasKeys,
      },
    });
    await db.collection("tallerData").doc("expertTaller.settings").set({
      value: settings,
      updatedAt: Date.now(),
    });

    res.status(200).json({
      ok: true,
      enviado: true,
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
