# coperacha-app

App de [Coperacha](https://coperacha.app): colectas en grupo («coperachas») para un regalo
sorpresa, todo o nada. Junta compromisos por web y WhatsApp, cobra sólo si se llega a la
meta y cada cobro CoDi (vía Pey) va directo a la CLABE de quien organiza. Coperacha nunca
guarda dinero.

Repo público. Nunca subir secretos, claves ni datos de usuarios. La landing vive en
`coperacha-landing`.

## Stack

- Node.js 20, JavaScript (ESM), sin dependencias de npm: `node:http`, `node:test`, `fetch`.
- Persistencia: un archivo JSON (`DATABASE_PATH`) con esquema en `src/db/schema.md`; la
  interfaz `Store` es el punto para pasar a SQLite.

## Setup local

```bash
cp .env.example .env        # llenar SESSION_SECRET; con AUTH_DEV_LOGIN=true no hace falta Google
npm test                    # 33 tests, sin red
npm start                   # http://localhost:3000
```

Recorrido: entrar (`/auth/dev` en local o Google), crear colecta, copiar el link `/c/<code>`,
abrirlo en otra ventana privada y sumarse, proponer y votar regalo, ver el menú (sin ver
quién puso cuánto), llegar a la meta, «Confirmar y mandar cobros» y recién ahí ver la lista.

### Google OAuth para uso local

1. Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application).
2. Authorized redirect URI: `http://localhost:3000/auth/google/callback`.
3. Copiar client id y secret a `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; `GOOGLE_REDIRECT_URI`
   igual al paso 2. Con `AUTH_DEV_LOGIN=false` la única entrada es Google.

## Arquitectura

```
src/server.js            arma todo (config, store, clientes, servicio, HTTP) y el job de deadlines
src/web/app.js           rutas: auth, dashboard, colectas, /c/<code>, webhooks
src/web/views.js         HTML en español (tú); la lista de aportaciones sólo se renderiza si el servicio la expone
src/domain/colecta.js    ciclo de vida: crear, sumarse, evaluar meta, confirmar, vencimiento, salidas
src/domain/amounts.js    reglas de montos (parte igual, mayoría, tope privado)
src/domain/voting.js     propuestas y votos
src/domain/messages.js   copy de WhatsApp
src/services/notifier.js eventos → mensajes → cola
src/integrations/        arturito (send/register), outbound-queue (6/min), pey (CoDi)
src/whatsapp/inbound.js  comandos entrantes
src/auth/google.js       OAuth 2.0 + stub local
src/db/store.js          repositorio JSON
```

Estados de una colecta: `open` → `goal_reached` (la suma llega a la meta) → `confirmed` (el
organizador confirma: se congelan montos y salen los cobros) · `open` → `failed` (venció sin
meta) → cambiar regalo / bajar meta (vuelve a `open` o `goal_reached`) / `cancelled`.

### Reglas de montos

Todo en centavos. N = personas sumadas (cualquier modalidad).

1. **Parte igual** = `ceil(meta / N)`. Cambia cada vez que alguien se suma.
2. **Montos públicos** = montos fijos + partes iguales resueltas. El tope de «lo que ponga la
   mayoría» nunca es público.
3. **Monto de la mayoría** = el más frecuente entre los montos públicos; empate → el mayor; si
   no hay montos públicos, la parte igual.
4. **Mayoría con tope X** paga `min(mayoría, X)`.
5. **Total en curso** (antes de confirmar) suma a todos con su monto resuelto actual, incluidos
   los de tope al valor provisional `min(mayoría, X)`. Sólo se muestra el agregado. Límite
   conocido: con muy pocos participantes, el organizador podría inferir X a partir del total.
6. Al confirmar se congelan los montos (`finalCents`) y recién ahí se muestra quién puso cuánto.

Modalidad de reparto: `equal` sólo permite parte igual o mayoría con tope; `free` suma monto fijo.

### Votación

Cualquiera (organizador o persona sumada) propone. Un voto por persona; volver a votar lo
reemplaza. Gana la propuesta con más votos; en empate, la más antigua. El organizador cierra
con la ganadora, con una propuesta concreta o con su propia elección.

### Privacidad

- `contributorList()` en `src/domain/colecta.js` es el único lugar que expone nombre + monto y
  devuelve `null` salvo en `confirmed`. Web y WhatsApp lo consumen de ahí.
- El organizador ve nombres, cantidad de personas, total y faltante; nunca montos por persona
  antes de confirmar.
- Logs sin texto de mensajes, nombres ni teléfonos: sólo `chatId`, `type`, `messageId` e ids.

## Variables de entorno

Nombres en `.env.example` (comentados): `PORT`, `APP_BASE_URL`, `SESSION_SECRET`,
`COOKIE_SECURE`, `DATABASE_PATH`, `APP_TIMEZONE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI`, `AUTH_DEV_LOGIN`, `ARTURITO_PHONE`, `ARTURITO_SEND_URL`,
`ARTURITO_SEND_KEY`, `ARTURITO_REGISTER_URL`, `ARTURITO_REGISTER_TOKEN`,
`ARTURITO_WEBHOOK_TOKEN`, `ARTURITO_SEND_LIMIT_PER_MINUTE`, `PEY_MODE`, `PEY_API_URL`,
`PEY_API_KEY`, `PEY_WEBHOOK_SECRET`.

## WhatsApp (Arturito)

Esta app es cliente del bot Arturito; no modifica ese repo.

- **Salida**: `POST ARTURITO_SEND_URL` con `{chatId, type:"text", text}` y
  `Authorization: Bearer ARTURITO_SEND_KEY`. `chatId` = `<dígitos>@s.whatsapp.net` (o el `@lid`
  con el que llegó). 202 encolado, 403 chat no permitido (se descarta), 503 desconectado (se
  reintenta a los 30 s, hasta 5 veces). Todo pasa por `OutboundQueue`: ventana deslizante de
  6 mensajes por minuto, FIFO, sin ráfagas.
- **Registro**: al crear una colecta y al sumarse alguien, `ArturitoClient.register` hace
  `POST ARTURITO_REGISTER_URL` con `{phone, chatId, app:"coperacha", role}` y Bearer
  `ARTURITO_REGISTER_TOKEN` (o `ARTURITO_SEND_KEY`). Es la suposición de esta app sobre el
  registry de Arturito; si la URL está vacía se registra un log y se sigue.
- **Entrada**: `POST /webhooks/arturito` con `Authorization: Bearer ARTURITO_WEBHOOK_TOKEN` y
  cuerpo `{chatId, type, messageId, text}` (o `{events:[...]}`). Sólo responde a números ya
  sumados a una colecta activa (si están en varias, la más reciente). Comandos: `menu`,
  `proponer <idea>`, `votar`, `votar <n>`, `cuánto falta`, `mi monto`. Chats desconocidos o
  tipos que no son texto: no-op.
- **Notificaciones**: confirmación al sumarse, hitos 50 % y 75 % (al organizador), meta
  alcanzada (al organizador, con link para confirmar), recordatorio 24 h antes del cierre,
  cobro CoDi, vencimiento con las tres salidas, reapertura, cancelación y regalo elegido.
- Teléfonos: se guardan como dígitos internacionales (`52` + 10 dígitos; el `521` viejo se
  normaliza). `ARTURITO_PHONE` en ese mismo formato para el link `wa.me`.

## Pey (CoDi)

Interfaz mínima en `src/integrations/pey.js`:

- `createCharge({reference, amountCents, concept, beneficiaryClabe, beneficiaryName, payerPhone})`
  → `{chargeId, status, paymentUrl}`. Beneficiario = CLABE del organizador, siempre.
- `parseWebhook({headers, rawBody})` → `{chargeId, status, reference}`; verifica
  `x-pey-signature` (HMAC-SHA256 hex del cuerpo con `PEY_WEBHOOK_SECRET`) o
  `Authorization: Bearer PEY_WEBHOOK_SECRET`; si no, 401.

`PEY_MODE=mock` (default y en tests) usa `MockPeyClient`, que registra cobros y arma webhooks
firmados. `PEY_MODE=http` usa `HttpPeyClient` contra `PEY_API_URL/charges`; el formato del
cuerpo y de los estados (`paid`, `failed`, `expired`, `pending`) es una suposición a ajustar
contra el sandbox real. Los tests nunca tocan la red.

## Hosting propuesto (no desplegado)

Cuenta AWS 355622872251, región us-east-2, perfil `coperacha`, prefijo `coperacha-`:

- Opción preferida: un contenedor chico (App Runner o ECS Fargate, 0.25 vCPU) detrás de
  HTTPS en `app.coperacha.app`, con el archivo de datos en un volumen EFS o, mejor, migrando a
  SQLite/RDS antes de salir. Lambda + Function URL también sirve, pero el store en archivo y la
  cola en memoria piden un proceso persistente.
- Secretos en Secrets Manager; deploy por GitHub Actions con OIDC (rol
  `github-coperacha-app-deploy`), sólo con el OK de JI.

## Preguntas abiertas

- Verificar el WhatsApp de cada participante con un código (hoy se confía en el número
  escrito; fuera de alcance del MVP).
- Forma real de la API y los webhooks de Pey (sandbox): confirmar campos, firma y estados.
- Registry de Arturito: confirmar endpoint y payload de registro.
- Qué pasa si alguien no paga su cobro CoDi después de confirmar (reintento, recordatorio,
  reasignar).
- Mapeo de chats `@lid` a teléfonos (hoy se ignoran).
- Pasar el store a SQLite y la cola a algo persistente antes de producción.

## Notas de trabajo

Backlog: [docs/ROADMAP.md](./docs/ROADMAP.md). Estado actual: el plan de sesión más reciente
en [docs/sessions/](./docs/sessions/).
