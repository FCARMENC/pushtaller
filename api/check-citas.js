// api/check-citas.js
// -----------------------------------------------------------------------------
// A diferencia de check-pagos.js (que corre 1 vez al día con el cron de Vercel),
// esta función necesita revisar cada pocos minutos para avisar justo a la hora
// de cada cita. El plan gratis de Vercel no deja cron tan seguido, así que la
// dispara un workflow de GitHub Actions cada 10 minutos (ver
// .github/workflows/check-citas.yml en el repo de pushtaller) en vez del cron
// de vercel.json.
// -----------------------------------------------------------------------------
const admin = require("firebase-admin");

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
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

    const [citasSnap, tokensSnap] = await Promise.all([
      db.collection("tallerData").doc("expertTaller.appointments").get(),
      db.collection("tallerData").doc("expertTaller.fcmTokens").get(),
    ]);

    const citas = (citasSnap.exists && citasSnap.data().value) || [];
    const tokens = (tokensSnap.exists && tokensSnap.data().value) || [];
    const ahora = new Date();

    const avisos = [];
    const citasActualizadas = citas.map((cita) => {
      if (cita.notified || !cita.date || !cita.time) return cita;
      // Perú es UTC-5 todo el año (sin horario de verano) — lo fijamos explícito para que
      // no dependa de en qué zona horaria corra el servidor de Vercel.
      const inicio = new Date(`${cita.date}T${cita.time}:00-05:00`);
      const minutosParaEmpezar = (inicio.getTime() - ahora.getTime()) / 60000;
      // Avisa si la cita ya empezó (con hasta 15 min de margen, por si una revisión se atrasa
      // o se salta) pero no si ya pasó de largo ese margen.
      if (minutosParaEmpezar <= 0 && minutosParaEmpezar >= -15) {
        avisos.push(cita);
        return { ...cita, notified: true };
      }
      return cita;
    });

    if (!avisos.length) {
      res.status(200).json({ ok: true, avisos: 0 });
      return;
    }

    if (tokens.length) {
      for (const cita of avisos) {
        await admin.messaging().sendEachForMulticast({
          tokens: tokens,
          notification: {
            title: "\uD83D\uDD14 Cita ahora: " + (cita.client || "Cliente"),
            body: `${cita.service || "Servicio"}${cita.vehicle ? " \u00b7 " + cita.vehicle : ""} \u00b7 ${cita.time}`,
          },
          data: { tag: "cita-" + cita.id },
          webpush: { fcmOptions: { link: "/" } },
        });
      }
    }

    await db.collection("tallerData").doc("expertTaller.appointments").set({
      value: citasActualizadas,
      updatedAt: Date.now(),
    });

    res.status(200).json({ ok: true, avisos: avisos.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error interno" });
  }
};
