// POST /api/notify  — avisos libres del equipo (abono, "Avisos al equipo", prueba).
// Ya NO usa un secreto escrito en el navegador: exige la sesión de la cuenta del taller
// (token de Firebase Auth con correo y contraseña). Env: FIREBASE_SERVICE_ACCOUNT_JSON.
const { applyCors, parseBody, clean, requireStaff, sendToAll } = require("../lib/common");

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }
  try {
    await requireStaff(req);
  } catch (e) {
    res.status(401).json({ error: "Inicia sesión con la cuenta del taller" });
    return;
  }
  try {
    const body = parseBody(req);
    const title = clean(body.title || "Expert", 120);
    const msgBody = clean(body.body, 500);
    const tag = clean(body.tag || "aviso-equipo", 64);
    const out = await sendToAll(title, msgBody, tag);
    res.status(200).json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e && e.message) || "Error interno" });
  }
};
