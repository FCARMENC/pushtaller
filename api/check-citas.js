// api/check-citas.js
// -----------------------------------------------------------------------------
// A diferencia de check-pagos.js (que corre 1 vez al día con el cron de Vercel),
// esta función necesita revisar cada pocos minutos para respetar horas exactas.
// El plan gratis de Vercel no deja cron tan seguido, así que la dispara un
// workflow de GitHub Actions cada 10 minutos (ver
// .github/workflows/check-citas.yml en el repo de pushtaller) en vez del cron
// de vercel.json. Hace dos cosas:
//   1. Avisa de las citas de Agenda: un aviso X minutos antes (si está
//      configurado en Avisos al equipo) y otro justo a la hora.
//   2. Manda el recordatorio diario al equipo a la hora que se haya elegido
//      (también en Avisos al equipo) — una vez por día, a esa hora exacta.
// -----------------------------------------------------------------------------
const admin = require("firebase-admin");

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// Perú es UTC-5 todo el año (sin horario de verano). A partir de un instante en UTC, devuelve la
// fecha "YYYY-MM-DD" que corresponde en Perú — no siempre es la misma que en UTC (por ejemplo,
// entre las 00:00 y 05:00 UTC todavía es el día anterior en Perú).
function peruDateKey(d) {
  return new Date(d.getTime() - 5 * 3600000).toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  // Solo quien tenga el secreto (el workflow de GitHub Actions) puede disparar esto.
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
    const settings = (settingsSnap.exists && settingsSnap.data().value) || {};
    const ahora = new Date();
    const minutosAntes = (settings.recordatorioCitas && Number(settings.recordatorioCitas.minutosAntes)) || 0;

    // --- 1. Citas: aviso "antes" (si está configurado) y aviso "a la hora" ---
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
        const title = cita._tipo === "antes"
          ? `\u23F0 Cita en ${cita._min} min: ` + (cita.client || "Cliente")
          : "\uD83D\uDD14 Cita ahora: " + (cita.client || "Cliente");
        await admin.messaging().sendEachForMulticast({
          tokens: tokens,
          notification: {
            title: title,
            body: `${cita.service || "Servicio"}${cita.vehicle ? " \u00b7 " + cita.vehicle : ""} \u00b7 ${cita.time}`,
          },
          data: { tag: "cita-" + cita.id + "-" + cita._tipo },
          webpush: { fcmOptions: { link: "/" } },
        });
      }
    }

    if (avisosCitas.length) {
      await db.collection("tallerData").doc("expertTaller.appointments").set({
        value: citasActualizadas,
        updatedAt: Date.now(),
      });
    }

    // --- 2. Recordatorio diario al equipo, a la hora configurada ---
    let recordatorioEnviado = false;
    const recordatorio = settings.recordatorioEquipo;
    if (recordatorio && recordatorio.activo) {
      const hoyKey = peruDateKey(ahora);
      const objetivoHoy = new Date(`${hoyKey}T${recordatorio.hora || "08:00"}:00-05:00`);
      if (ahora.getTime() >= objetivoHoy.getTime() && recordatorio.lastSentKey !== hoyKey) {
        if (tokens.length) {
          await admin.messaging().sendEachForMulticast({
            tokens: tokens,
            notification: {
              title: "\uD83D\uDCE2 Aviso del taller",
              body: recordatorio.mensaje || "No olvides registrar las \u00f3rdenes y movimientos de hoy en el sistema \uD83D\uDCAA",
            },
            data: { tag: "recordatorio-equipo-" + hoyKey },
            webpush: { fcmOptions: { link: "/" } },
          });
        }
        await db.collection("tallerData").doc("expertTaller.settings").set({
          value: { ...settings, recordatorioEquipo: { ...recordatorio, lastSentKey: hoyKey } },
          updatedAt: Date.now(),
        });
        recordatorioEnviado = true;
      }
    }

    res.status(200).json({ ok: true, avisosCitas: avisosCitas.length, recordatorioEquipo: recordatorioEnviado });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error interno" });
  }
};
