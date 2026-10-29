// POST /api/notify-solicitud  { id }
// El formulario QR avisa que creó una solicitud. El servidor lee la solicitud con acceso de
// administrador, comprueba que sea reciente y no avisada antes, y arma el texto aquí.
// Además limita el ritmo: como máximo un aviso cada 15 segundos (anti-spam).
const { admin, applyCors, getAdminApp, parseBody, clean, sendToAll } = require("../lib/common");

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }
  try {
    const id = String(parseBody(req).id || "");
    if (!/^solicitud_\d{13}_[a-z0-9]{6}$/.test(id)) {
      res.status(400).json({ error: "Solicitud inválida" });
      return;
    }
    getAdminApp();
    const db = admin.firestore();
    const ref = db.collection("tallerData").doc(id);
    const thRef = db.collection("tallerData").doc("push_throttle_solicitud");

    const r = await db.runTransaction(async function (tx) {
      const snap = await tx.get(ref);
      const th = await tx.get(thRef);
      if (!snap.exists) return { skip: "no-existe" };
      const d = snap.data();
      const v = d.value || {};
      if (v.type !== "solicitud_publica") return { skip: "tipo" };
      if (d.pushedAt) return { skip: "ya-enviado" };
      const now = Date.now();
      if (!v.createdAt || now - Number(v.createdAt) > 10 * 60 * 1000) return { skip: "vieja" };
      tx.update(ref, { pushedAt: now });
      const last = th.exists ? Number(th.data().at) || 0 : 0;
      if (now - last < 15000) return { skip: "limite-de-ritmo" };
      tx.set(thRef, { at: now });
      return { v: v };
    });
    if (r.skip) {
      res.status(200).json({ ok: true, sent: 0, skipped: r.skip });
      return;
    }
    const parts = [clean(r.v.name, 60)];
    if (r.v.vehicle) parts.push(clean(r.v.vehicle, 60));
    if (r.v.need) parts.push(clean(r.v.need, 100));
    const out = await sendToAll("Nueva solicitud de cita", parts.join(" · "), "solicitud-" + id.slice(-6));
    res.status(200).json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno" });
  }
};
