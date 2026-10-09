// api/check-citas.js
// -----------------------------------------------------------------------------
// Disparado cada ~10 min (cron-job.org o GitHub Actions).
// 1) Avisos de citas (antes + a la hora)
// 2) Recordatorio diario al equipo (hora configurada en Avisos)
// 3) Resumen del taller / mensaje motivador (Ajustes → Resúmenes y tips del día)
// El bloque 3 va aislado en try/catch para que NUNCA tumbe 1 ni 2.
// -----------------------------------------------------------------------------
const admin = require("firebase-admin");

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function peruDateKey(d) {
  return new Date(d.getTime() - 5 * 3600000).toISOString().slice(0, 10);
}

function peruTimeHM(d) {
  const p = new Date(d.getTime() - 5 * 3600000);
  const hh = String(p.getUTCHours()).padStart(2, "0");
  const mm = String(p.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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
  const listos = (orders || []).filter((o) => o.status === "listo").length;
  const espera = (orders || []).filter((o) => o.status === "espera_repuesto").length;
  const bajoStock = (parts || []).filter((p) => p.stock <= (p.min != null ? p.min : 0)).length;
  const citasHoy = (appointments || []).filter((a) => a.date === hoyKey).length;
  const pfPend = (proformas || []).filter((p) => p.status === "pendiente").length;
  const activos = (orders || []).filter((o) => o.status !== "entregado").length;

  const tips = [];
  if (listos > 0) tips.push(`${listos} orden${listos > 1 ? "es" : ""} lista${listos > 1 ? "s" : ""} para entregar`);
  if (espera > 0) tips.push(`${espera} esperando repuesto`);
  if (bajoStock > 0) tips.push(`${bajoStock} repuesto${bajoStock > 1 ? "s" : ""} con stock bajo`);
  if (citasHoy > 0) tips.push(`${citasHoy} cita${citasHoy > 1 ? "s" : ""} hoy`);
  if (pfPend > 0) tips.push(`${pfPend} proforma${pfPend > 1 ? "s" : ""} pendiente${pfPend > 1 ? "s" : ""}`);
  if (tips.length === 0 && activos > 0) tips.push(`${activos} orden${activos > 1 ? "es" : ""} activa${activos > 1 ? "s" : ""} en el taller`);

  if (tips.length === 0) return null;
  return { title: "Resumen del taller 📋", body: tips.slice(0, 3).join(" · ") };
}

async function sendPush(tokens, title, body, tag) {
  if (!tokens || !tokens.length) return { successCount: 0, failureCount: 0 };
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { tag: String(tag || "aviso") },
    webpush: { fcmOptions: { link: "/" } },
  });
  return res;
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || "";
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }

  try {
    getAdminApp();
    const db = admin.firestore();

    const [citasSnap, tokensSnap, settingsSnap] = await Promise.all([
      db.collection("tallerData").doc("expertTaller.appointments").get(),
      db.collection("tallerData").doc("expertTaller.fcmTokens").get(),
      db.collection("tallerData").doc("expertTaller.settings").get(),
    ]);

    const citas = (citasSnap.exists && citasSnap.data().value) || [];
    const tokens = (tokensSnap.exists && tokensSnap.data().value) || [];
    let settings = (settingsSnap.exists && settingsSnap.data().value) || {};
    const ahora = new Date();
    const minutosAntes = (settings.recordatorioCitas && Number(settings.recordatorioCitas.minutosAntes)) || 0;

    // --- 1. Citas (igual que antes) ---
    const avisosCitas = [];
    const citasActualizadas = citas.map((cita) => {
      if (!cita.date || !cita.time) return cita;
      const inicio = new Date(`${cita.date}T${cita.time}:00-05:00`);
      const minutosParaEmpezar = (inicio.getTime() - ahora.getTime()) / 60000;
      let actualizada = cita;
      if (minutosAntes > 0 && !cita.notifiedAntes && minutosParaEmpezar > 0 && minutosParaEmpezar <= minutosAntes) {
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
            ? `⏰ Cita en ${cita._min} min: ` + (cita.client || "Cliente")
            : "🔔 Cita ahora: " + (cita.client || "Cliente");
        await sendPush(
          tokens,
          title,
          `${cita.service || "Servicio"}${cita.vehicle ? " · " + cita.vehicle : ""} · ${cita.time}`,
          "cita-" + cita.id + "-" + cita._tipo
        );
      }
    }

    if (avisosCitas.length) {
      await db.collection("tallerData").doc("expertTaller.appointments").set({
        value: citasActualizadas,
        updatedAt: Date.now(),
      });
    }

    // --- 2. Recordatorio diario al equipo (mañana) ---
    let recordatorioEnviado = false;
    const recordatorio = settings.recordatorioEquipo;
    if (recordatorio && recordatorio.activo) {
      const hoyKey = peruDateKey(ahora);
      const objetivoHoy = new Date(`${hoyKey}T${recordatorio.hora || "08:00"}:00-05:00`);
      if (ahora.getTime() >= objetivoHoy.getTime() && recordatorio.lastSentKey !== hoyKey) {
        if (tokens.length) {
          await sendPush(
            tokens,
            "📢 Aviso del taller",
            recordatorio.mensaje || "No olvides registrar las órdenes y movimientos de hoy en el sistema 💪",
            "recordatorio-equipo-" + hoyKey
          );
        }
        settings = {
          ...settings,
          recordatorioEquipo: { ...recordatorio, lastSentKey: hoyKey },
        };
        await db.collection("tallerData").doc("expertTaller.settings").set({
          value: settings,
          updatedAt: Date.now(),
        });
        recordatorioEnviado = true;
      }
    }

    // --- 3. Resumen / motivador (aislado: si falla, no afecta 1 ni 2) ---
    let resumenEnviado = false;
    let resumenError = null;
    try {
      const rd = settings.resumenDiario || {};
      if (rd.activo && tokens.length) {
        const hoyKey = peruDateKey(ahora);
        const horaAhora = peruTimeHM(ahora);
        const inicio = rd.ventanaInicio || "08:00";
        const fin = rd.ventanaFin || "20:00";
        const maxPorDia = Number(rd.maxPorDia) || 4;
        const lastSentKeys = Array.isArray(rd.lastSentKeys) ? rd.lastSentKeys : [];
        const enviadosHoy = lastSentKeys.filter((k) => String(k).startsWith(hoyKey));

        if (horaAhora >= inicio && horaAhora <= fin && enviadosHoy.length < maxPorDia && Math.random() < 0.25) {
          let orders = [], parts = [], proformas = [];
          try {
            const [ordersSnap, partsSnap, pfSnap] = await Promise.all([
              db.collection("tallerData").doc("expertTaller.orders").get(),
              db.collection("tallerData").doc("expertTaller.parts").get(),
              db.collection("tallerData").doc("expertTaller.proformas").get(),
            ]);
            orders = (ordersSnap.exists && ordersSnap.data().value) || [];
            parts = (partsSnap.exists && partsSnap.data().value) || [];
            proformas = (pfSnap.exists && pfSnap.data().value) || [];
          } catch (e) {
            // si no se pueden leer, igual mandamos motivador
          }

          const resumen = buildResumen(orders, parts, citas, proformas, hoyKey);
          const msg = resumen || MOTIVATIONAL[Math.floor(Math.random() * MOTIVATIONAL.length)];

          await sendPush(tokens, msg.title, msg.body, "resumen-diario-" + hoyKey + "-" + horaAhora);

          const nuevaKey = `${hoyKey}-${horaAhora}`;
          const nuevasKeys = [...enviadosHoy, nuevaKey].slice(-12);
          settings = {
            ...settings,
            resumenDiario: {
              activo: true,
              maxPorDia,
              ventanaInicio: inicio,
              ventanaFin: fin,
              lastSentKeys: nuevasKeys,
            },
          };
          await db.collection("tallerData").doc("expertTaller.settings").set({
            value: settings,
            updatedAt: Date.now(),
          });
          resumenEnviado = true;
        }
      }
    } catch (e) {
      resumenError = (e && e.message) || String(e);
      console.error("resumenDiario error:", e);
    }

    res.status(200).json({
      ok: true,
      tokens: tokens.length,
      avisosCitas: avisosCitas.length,
      recordatorioEquipo: recordatorioEnviado,
      resumenDiario: resumenEnviado,
      resumenError,
      horaPeru: peruTimeHM(ahora),
      fechaPeru: peruDateKey(ahora),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error interno" });
  }
};
