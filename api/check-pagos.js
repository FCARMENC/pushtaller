// api/check-pagos.js
// -----------------------------------------------------------------------------
// Corre sola una vez al día (ver vercel.json) y revisa los "pagos programados"
// guardados en Firestore (alquiler, proveedores, etc.). Si alguno vence dentro
// de los próximos DIAS_AVISO días y todavía no se avisó por esa fecha, manda
// un push — un solo aviso por vencimiento, no todos los días mientras se acerca.
//
// El recordatorio diario al equipo (con hora configurable) y los avisos de
// citas viven en check-citas.js, que corre cada 10 min vía GitHub Actions —
// ahí sí se puede respetar una hora exacta, cosa que el cron de Vercel (1 vez
// al día) no permite en el plan gratis.
// -----------------------------------------------------------------------------
const admin = require("firebase-admin");

const DIAS_AVISO = 3; // avisa desde N días antes del vencimiento (y el mismo día, si el cron cae justo ahí)

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// Calcula la próxima fecha de vencimiento de un pago (recurrente mensual, o de fecha única).
function proximaFecha(pago, hoy) {
  if (pago.recurrente) {
    const dia = Math.min(28, Math.max(1, Number(pago.diaMes) || 1));
    let candidata = new Date(hoy.getFullYear(), hoy.getMonth(), dia);
    if (candidata < hoy) {
      candidata = new Date(hoy.getFullYear(), hoy.getMonth() + 1, dia);
    }
    return candidata;
  }
  if (pago.fecha) {
    return new Date(pago.fecha + "T00:00:00");
  }
  return null;
}

module.exports = async (req, res) => {
  // Solo el cron de Vercel (que manda este secreto solo) puede disparar esto.
  const auth = req.headers.authorization || "";
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }

  try {
    getAdminApp();
    const db = admin.firestore();

    const [pagosSnap, tokensSnap] = await Promise.all([
      db.collection("tallerData").doc("expertTaller.pagosProgramados").get(),
      db.collection("tallerData").doc("expertTaller.fcmTokens").get(),
    ]);

    const pagos = (pagosSnap.exists && pagosSnap.data().value) || [];
    const tokens = (tokensSnap.exists && tokensSnap.data().value) || [];

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const avisos = [];
    const pagosActualizados = pagos.map((pago) => {
      if (pago.activo === false) return pago;
      const venc = proximaFecha(pago, hoy);
      if (!venc) return pago;
      const dias = Math.round((venc - hoy) / 86400000);
      const key = venc.toISOString().slice(0, 10);
      if (dias >= 0 && dias <= DIAS_AVISO && pago.lastNotifiedKey !== key) {
        avisos.push({ nombre: pago.nombre, monto: pago.monto, dias: dias, key: key });
        return { ...pago, lastNotifiedKey: key };
      }
      return pago;
    });

    if (!avisos.length) {
      res.status(200).json({ ok: true, avisos: 0 });
      return;
    }

    if (tokens.length) {
      for (const aviso of avisos) {
        const cuando = aviso.dias === 0 ? "hoy" : aviso.dias === 1 ? "mañana" : `en ${aviso.dias} días`;
        await admin.messaging().sendEachForMulticast({
          tokens: tokens,
          notification: {
            title: "Pago próximo: " + aviso.nombre,
            body: `Vence ${cuando} \u00b7 S/ ${Number(aviso.monto).toFixed(2)}`,
          },
          data: { tag: "pago-" + aviso.key },
          webpush: { fcmOptions: { link: "/" } },
        });
      }
    }

    await db.collection("tallerData").doc("expertTaller.pagosProgramados").set({
      value: pagosActualizados,
      updatedAt: Date.now(),
    });

    res.status(200).json({ ok: true, avisos: avisos.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error interno" });
  }
};
