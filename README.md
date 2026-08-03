# Avisos push para Expert Taller (con la app cerrada, gratis)

Esto hace que tu celular reciba una notificación del sistema apenas un
cliente aprueba o rechaza una proforma — incluso con Expert totalmente
cerrado — sin pasar al plan pago de Firebase (Blaze).

Cómo funciona: el envío del push (Firebase Cloud Messaging) es gratis en
cualquier plan. Lo único que normalmente cuesta es la función que "escucha"
cuando cambia Firestore y dispara el aviso (Cloud Functions). Esa función la
alojamos gratis en **Vercel** en vez de en Firebase.

---

## Parte A — Clave VAPID (para que el navegador pueda recibir push)

1. Ve a [Firebase Console](https://console.firebase.google.com) → tu
   proyecto `taller-fc741`.
2. **Configuración del proyecto** (engranaje) → pestaña **Cloud Messaging**.
3. Baja hasta **"Certificados push web"** → **Generar par de claves**.
4. Copia la clave larga que aparece (empieza distinto cada vez, es única de
   tu proyecto).
5. En tu `index.html`, busca `const VAPID_KEY = "";` y pega la clave ahí
   dentro de las comillas.

## Parte B — Credencial de administrador (para que Vercel pueda enviar el push)

1. En Firebase Console → **Configuración del proyecto** → pestaña
   **Cuentas de servicio**.
2. Clic en **"Generar nueva clave privada"** → se descarga un archivo
   `.json`. **Guárdalo bien, no lo subas a GitHub ni lo compartas.**
3. Abre ese archivo, vas a necesitar tres valores de ahí:
   - `project_id`
   - `client_email`
   - `private_key`

## Parte C — Desplegar la función en Vercel

1. Crea una cuenta gratis en [vercel.com](https://vercel.com) (puedes
   entrar con tu cuenta de GitHub).
2. Sube la carpeta `vercel-push` (la que contiene `api/notify.js` y
   `package.json`) a un repositorio de GitHub **aparte** de tu app
   principal (puede ser privado).
3. En Vercel: **Add New → Project** → selecciona ese repositorio →
   **Deploy** (no hace falta tocar ninguna otra opción de build).
4. Cuando termine, entra a **Settings → Environment Variables** del
   proyecto en Vercel y agrega:
   | Nombre | Valor |
   |---|---|
   | `FIREBASE_PROJECT_ID` | el `project_id` del archivo .json |
   | `FIREBASE_CLIENT_EMAIL` | el `client_email` del archivo .json |
   | `FIREBASE_PRIVATE_KEY` | el `private_key` del archivo .json (tal cual, con los `\n`) |
   | `NOTIFY_SECRET` | una contraseña larga que inventes tú (ej. genera una en un gestor de contraseñas) |
5. Ve a **Deployments** → los tres puntos del último deploy → **Redeploy**
   (para que tome las variables de entorno nuevas).
6. Copia la URL pública que te dio Vercel, algo como
   `https://expert-taller-push.vercel.app`. La URL de tu función es esa
   más `/api/notify`, por ejemplo:
   `https://expert-taller-push.vercel.app/api/notify`

## Parte D — Conectar todo en index.html

En tu `index.html`, completa estas tres constantes (cerca de
`FIREBASE_CONFIG`):

```js
const VAPID_KEY = "pega-aquí-la-clave-de-la-parte-A";
const NOTIFY_ENDPOINT = "https://tu-proyecto.vercel.app/api/notify";
const NOTIFY_SECRET = "la-misma-contraseña-que-pusiste-en-NOTIFY_SECRET-en-Vercel";
```

Sube también el archivo `firebase-messaging-sw.js` a la **raíz** de tu
repo de GitHub Pages, junto al `index.html` (mismo nivel, no en una
subcarpeta).

## Parte E — Probar

1. Publica los cambios en GitHub Pages.
2. Abre Expert, toca la campana → **"Activar avisos en este celular"** →
   acepta el permiso del navegador.
3. En el panel de la campana debería decir *"Avisos activos en este
   dispositivo, incluso con la app cerrada."*
4. Cierra Expert por completo en el celular.
5. Desde otro dispositivo (o el mismo), aprueba una proforma de prueba
   usando el enlace de aprobación.
6. En unos segundos debería llegarte la notificación del sistema al
   celular.

Si no llega, revisa en Vercel → tu proyecto → **Logs** para ver el error
exacto de la función `notify`.
