// POST /api/notify-proforma  { token }
// El cliente avisa que respondió su presupuesto. NO se confía en el navegador: se lee el
// documento pub_<token> con acceso de administrador, se comprueba que de verdad tenga una
// respuesta nueva y el texto del aviso se arma aquí. Un mismo aviso se envía una sola vez.
const { admin, applyCors, getAdminApp, parseBody, clean, sendToAll } = require("../lib/common");

const IGV_RATE = 0.18;

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }
  try {
    const token = String(parseBody(req).token || "");
    if (!/^[A-Za-z0-9]{16,32}$/.test(token)) {
      res.status(400).json({ error: "Enlace inválido" });
      return;
    }
    getAdminApp();
    const db = admin.firestore();
    const ref = db.collection("tallerData").doc("pub_" + token);

    const r = await db.runTransaction(async function (tx) {
      const snap = await tx.get(ref);
      if (!snap.exists) return { skip: "no-existe" };
      const d = snap.data();
      const ca = d.clientApproval;
      if (!ca) return { skip: "sin-respuesta" };
      const key = String((ca.approved ? ca.approvedAt : ca.rejectedAt) || "");
      if (!key) return { skip: "sin-fecha" };
      if (d.pushedKey === key) return { skip: "ya-enviado" };
      tx.update(ref, { pushedKey: key });
      return { d: d, ca: ca };
    });
    if (r.skip) {
      res.status(200).json({ ok: true, sent: 0, skipped: r.skip });
      return;
    }

    const v = r.d.value || {};
    const pf = v.pf || {};
    const sub = (pf.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0) * (Number(it.price) || 0); }, 0);
    const total = sub + (pf.incluyeIgv ? sub * IGV_RATE : 0);
    const code = clean(pf.code, 30) || "Proforma";
    const who = clean(r.ca.approved ? r.ca.approvedBy : r.ca.rejectedBy, 60) || clean(v.client && v.client.name, 60) || "Cliente";
    const title = "Presupuesto " + code + (r.ca.approved ? " aprobado" : " rechazado");
    const body = r.ca.approved
      ? who + " aprobó S/ " + total.toFixed(2)
      : who + " rechazó el presupuesto" + (r.ca.reason ? ": " + clean(r.ca.reason, 120) : "");

    const out = await sendToAll(title, body, "proforma-" + token.slice(0, 8));
    res.status(200).json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno" });
  }
};
