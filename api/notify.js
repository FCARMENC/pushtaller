// api/notify.js
// -----------------------------------------------------------------------------
// Esta función corre gratis en Vercel (nada de Firebase Cloud Functions / plan
// Blaze). Expert la llama cuando pasa algo que el taller debe saber al toque:
//   - un cliente aprueba o rechaza una proforma desde el enlace público (manda proformaId), o
//   - llega una solicitud nueva desde el formulario público / QR (manda solo title y body).
// Ella:
//   1. Verifica el "secreto" para que nadie externo pueda spamear avisos.
//   2. Si hay proformaId, arma el mensaje leyendo esa proforma en Firestore; si no, usa el
//      título/cuerpo que le mandaron tal cual.
//   3. Manda el push a todos los dispositivos del taller vía Firebase Admin.
// -----------------------------------------------------------------------------
const admin = require("firebase-admin");

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  // Las credenciales se guardan en Vercel como un solo JSON completo
  // (FIREBASE_SERVICE_ACCOUNT_JSON), tal cual se descarga desde Firebase Console.
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

module.exports = async (req, res) => {
  // CORS: el index.html se sirve desde GitHub Pages, un origen distinto a Vercel.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  try {
    const { proformaId, secret, title: clientTitle, body: clientBody } = req.body || {};
    if (!secret || secret !== process.env.NOTIFY_SECRET) {
      res.status(401).json({ error: "Secreto inválido" });
      return;
    }
    getAdminApp();
    const db = admin.firestore();

    let title = clientTitle;
    let body = clientBody;

    if (proformaId) {
      // Caso de siempre: aviso de que el cliente aprobó/rechazó una proforma puntual.
      const proformasSnap = await db.collection("tallerData").doc("expertTaller.proformas").get();
      const proformas = (proformasSnap.exists && proformasSnap.data().value) || [];
      const pf = proformas.find((p) => p.id === proformaId);
      if (!pf) {
        res.status(404).json({ error: "Proforma no encontrada" });
        return;
      }
      const ca = pf.clientApproval || {};
      const total = (pf.items || []).reduce((s, it) => s + it.qty * it.price, 0) * (pf.incluyeIgv ? 1.18 : 1);
      // Preferimos el título/cuerpo que manda el cliente en el momento del clic: reflejan la
      // acción real sin depender de que la sincronización a Firestore (asíncrona, en index.html)
      // ya haya terminado de subir el nuevo estado cuando esta función lee el documento.
      title = clientTitle || (ca.approved ? `${pf.code} aprobada` : `${pf.code} rechazada`);
      body = clientBody || (ca.approved
        ? `${ca.approvedBy || "Cliente"} aprobó por S/ ${total.toFixed(2)}.`
        : `${ca.rejectedBy || "Cliente"} rechazó la proforma.${ca.reason ? " Motivo: " + ca.reason : ""}`);
    } else {
      // Caso genérico: por ejemplo, una nueva solicitud desde el formulario público (reservar.html).
      // No hay nada que buscar en Firestore, el título/cuerpo vienen directo de quien llama.
      if (!title || !body) {
        res.status(400).json({ error: "Falta proformaId, o falta title/body para un aviso sin proformaId" });
        return;
      }
    }

    const tokensSnap = await db.collection("tallerData").doc("expertTaller.fcmTokens").get();
    const tokens = (tokensSnap.exists && tokensSnap.data().value) || [];
    if (!tokens.length) {
      res.status(200).json({ ok: true, sent: 0, note: "No hay dispositivos registrados todavía." });
      return;
    }

    const response = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: { title: title, body: body },
      data: { tag: proformaId ? "proforma-" + proformaId : "solicitud", proformaId: proformaId || "" },
      webpush: { fcmOptions: { link: "/" } },
    });

    // Limpieza: si algún token ya no es válido (celular desinstaló la app, etc.), lo sacamos.
    const invalid = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
          invalid.push(tokens[i]);
        }
      }
    });
    if (invalid.length) {
      const cleaned = tokens.filter((t) => invalid.indexOf(t) === -1);
      await db.collection("tallerData").doc("expertTaller.fcmTokens").set({ value: cleaned, updatedAt: Date.now() });
    }

    res.status(200).json({ ok: true, sent: response.successCount, failed: response.failureCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error interno" });
  }
};
