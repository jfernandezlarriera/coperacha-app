# coperacha-app

App de [Coperacha](https://coperacha.app): colectas en grupo («coperachas») para un regalo
sorpresa, todo o nada. Junta compromisos por web y WhatsApp, cobra si se llega a la meta
(o si quien organiza confirma con lo que se juntó) y cada cobro CoDi (vía Pey) va directo
a la CLABE de quien organiza. Coperacha nunca guarda dinero.

Repo público. Nunca subir secretos, claves ni datos de usuarios. La landing vive en
`coperacha-landing`.

## Stack

- Node.js 20, JavaScript (ESM): `node:http`, `node:test`, `fetch`. Una sola dependencia de
  npm, `standardwebhooks`, para verificar los webhooks de Pey (`npm install` antes de correr).
- Persistencia: un archivo JSON (`DATABASE_PATH`) con esquema en `src/db/schema.md`; la
  interfaz `Store` es el punto para pasar a SQLite. En producción el mismo JSON se guarda en
  S3 (ver «Persistencia en S3»).

## Setup local

```bash
cp .env.example .env        # llenar SESSION_SECRET; con AUTH_DEV_LOGIN=true no hace falta Google
npm install                 # una dependencia: standardwebhooks
npm test                    # 53 tests, sin red
npm start                   # http://localhost:3000
```

Recorrido: entrar (`/auth/dev` en local o Google), crear colecta, copiar el link `/c/<code>`,
abrirlo en otra ventana privada y sumarse, proponer y votar regalo, ver el menú (sin ver
quién puso cuánto), llegar a la meta y «Confirmar y mandar cobros», o «Confirmar con lo que
se juntó» si todavía no se cubre la meta, y recién ahí ver la lista.

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
src/db/open-store.js     elige archivo local o archivo + copia en S3
src/db/s3-mirror.js      subida a S3 después de cada cambio (en serie, con reintentos)
src/db/s3-objects.js     cliente S3 mínimo (GET/PUT firmados con SigV4, sin dependencias)
```

`GET /health` responde `200 {"ok":true}` (health check de App Runner); `GET /healthz` suma el
tamaño de la cola de salida.

Estados de una colecta: `open` → `goal_reached` (la suma llega a la meta) → `confirmed` (el
organizador confirma: se congelan montos y salen los cobros) · `open` → `confirmed` (el
organizador confirma con lo que se juntó: la meta baja al total comprometido, los montos se
congelan contra la meta original y salen los cobros) · `open` → `failed` (venció sin
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
   Si se confirma con lo que se juntó, esos montos se calculan con la meta original (lo que
   cada persona ya había comprometido) y nunca suben; la meta queda en el total confirmado.

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
`COOKIE_SECURE`, `DATABASE_PATH`, `DATABASE_S3_BUCKET`, `DATABASE_S3_KEY`, `AWS_REGION`,
`APP_TIMEZONE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI`, `AUTH_DEV_LOGIN`, `ARTURITO_PHONE`, `ARTURITO_SEND_URL`,
`ARTURITO_SEND_KEY`,
`ARTURITO_WEBHOOK_TOKEN`, `ARTURITO_SEND_LIMIT_PER_MINUTE`, `PEY_MODE`, `PEY_API_URL`,
`PEY_API_KEY`, `PEY_WEBHOOK_SECRET`.

### Persistencia en S3

Sin `DATABASE_S3_BUCKET` (desarrollo local) el store es sólo el archivo `DATABASE_PATH`. Con
`DATABASE_S3_BUCKET` y `DATABASE_S3_KEY` (default `coperacha.json`; región en `AWS_REGION`,
default `us-east-2`):

- Al arrancar se baja el objeto de S3 y esa copia manda sobre el archivo local. Si el objeto
  todavía no existe se arranca con lo que haya local y se sube. Si la descarga falla por
  cualquier otro motivo el proceso no arranca, para no pisar datos con un store vacío.
- Después de cada cambio se sube el JSON completo. Las subidas van de a una, siempre con el
  estado más reciente, y se reintentan con espera creciente si S3 falla. Al recibir `SIGTERM`
  el proceso espera hasta 8 s a que termine la subida pendiente.
- Un solo escritor: una sola instancia por bucket/objeto.
- Credenciales: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (/ `AWS_SESSION_TOKEN`) del
  entorno o, en App Runner, el rol de la instancia. No lee `~/.aws` ni `AWS_PROFILE`.

## WhatsApp (Arturito)

Esta app es cliente del bot Arturito; no modifica ese repo.

- **Salida**: `POST ARTURITO_SEND_URL` con `{chatId, type:"text", text}` y
  `Authorization: Bearer ARTURITO_SEND_KEY`. `chatId` = `<dígitos>@s.whatsapp.net` (o el `@lid`
  con el que llegó). 202 encolado, 403 chat no permitido (se descarta), 503 desconectado (se
  reintenta a los 30 s, hasta 5 veces). Todo pasa por `OutboundQueue`: ventana deslizante de
  6 mensajes por minuto, FIFO, sin ráfagas.
- **Registro**: al crear una colecta y al sumarse alguien, `ArturitoClient.register` hace
  `POST <ARTURITO_SEND_URL>/registry` con cuerpo `{chatId}` (nada más) y
  `Authorization: Bearer ARTURITO_SEND_KEY`; `unregister` hace `DELETE` a la misma ruta con el
  mismo cuerpo (hoy ningún flujo lo llama). No hay URL ni token de registro aparte. La ruta se
  arma tolerando una `/` final en `ARTURITO_SEND_URL`. Si falta `ARTURITO_SEND_URL` o
  `ARTURITO_SEND_KEY` se omite el registro, se deja un log (sin la llave) y se sigue.
- **52 vs 521**: Arturito compara `chatId` de forma exacta y no normaliza. Para un celular
  mexicano se registran las dos formas: primero `521` + 10 dígitos + `@s.whatsapp.net` (el JID
  con el que suelen llegar los mensajes) y luego `52` + 10 dígitos (la forma que esta app
  guarda y usa para enviar). Los eventos entrantes con cualquiera de las dos formas encuentran
  al mismo participante.
- **`@lid` (pregunta abierta)**: si un evento llega con un `chatId` `@lid` no hay forma de
  mapearlo a un teléfono, así que hoy es un no-op y no se registra nada. Puede hacer falta que
  Coperacha registre el `@lid` cuando llegue uno; está pendiente de definir con Arturito.
- **Entrada**: `POST /webhooks/arturito` con `Authorization: Bearer ARTURITO_WEBHOOK_TOKEN` y
  cuerpo `{chatId, type, messageId, text}` (o `{events:[...]}`). Sólo responde a números ya
  sumados a una colecta activa (si están en varias, la más reciente). Comandos: `menu`,
  `proponer <idea>`, `votar`, `votar <n>`, `cuánto falta`, `mi monto`. Chats desconocidos o
  tipos que no son texto: no-op.
- **Notificaciones**: confirmación al sumarse, hitos 50 % y 75 % (al organizador), meta
  alcanzada (al organizador, con link para confirmar), recordatorio 24 h antes del cierre,
  cobro CoDi, confirmación con lo que se juntó (a cada participante, con su monto), vencimiento
  con las tres salidas, reapertura, cancelación y regalo elegido.
- Teléfonos: se guardan como dígitos internacionales (`52` + 10 dígitos; el `521` viejo se
  normaliza al guardar). `ARTURITO_PHONE` en ese mismo formato (sin el `1` extra) para el link
  `wa.me`.

## Pey (CoDi)

Cliente en `src/integrations/pey.js` contra `https://api.pey.mx` con
`Authorization: Bearer PEY_API_KEY`. `PEY_MODE=mock` (default y tests) usa
`MockPeyClient`, sin red; `PEY_MODE=http` usa `HttpPeyClient` y exige `PEY_API_KEY` y
`PEY_WEBHOOK_SECRET` (`PEY_API_URL` es sólo un override opcional de la base).

- **Cuenta del organizador**: al crear la colecta se valida la CLABE y se registra con
  `POST /bank-account` (`{alias, name, clabe, entity: "PERSON"}`). Se guardan `bankAccountId`
  y `codiStatus` (`PENDING`, `PROCESSING`, `ACTIVE`, `ERROR`) en la colecta; si el registro
  falla, la colecta no se crea. Los cobros nunca llevan una CLABE, sólo el `bankAccountId`.
  Las CLABEs preautorizadas por Pey (lista en `pey.js`) se activan al momento; cualquier otra
  puede tardar hasta 5 días hábiles y la interfaz lo dice. Mientras tanto la colecta funciona
  (sumarse, votar, avance), pero `confirm()` se rechaza y no hay botón de confirmar hasta que
  la cuenta esté `ACTIVE`. Al activarse se avisa al organizador por WhatsApp; `ERROR` se
  muestra en su panel.
- **Cobros**: `POST /codi/pn` con `{amount, phoneNumber, concept, expiration, numRef,
  bankAccountId, metadata}`: `amount` en pesos (convertido desde centavos sin flotantes),
  `phoneNumber` de 10 dígitos, `expiration` 86400 s, `numRef` de hasta 7 dígitos y
  `metadata = {reference, colecta, participant}`. Se guarda `transactionId` en el cobro. Si el
  push falla se intenta `POST /codi/qr` y el `qrString` va en el mensaje de WhatsApp; si fallan
  los dos, el cobro queda como `failed` (estado local).
- **Sin devoluciones ni eventos de fallo**: Pey sólo informa `PENDING` o `PAID`. El
  vencimiento es del lado de la app: un cobro que sigue pendiente después de su `expiresAt`
  pasa a `expired`.
- **Webhooks** (`POST /webhooks/pey`): se verifican con Standard Webhooks (paquete
  `standardwebhooks`, headers `webhook-id`, `webhook-timestamp`, `webhook-signature`, secreto
  `PEY_WEBHOOK_SECRET`) sobre el cuerpo crudo; firma inválida → 401. Se deduplica por
  `webhook-id` (colección `webhookEvents`): una repetición responde 200 sin efecto.
  `codi.pn.payment_received` y `codi.qr.payment_received` marcan el cobro como pagado (un id
  desconocido responde 200); `bank.account.updated` actualiza `codiStatus`.
- **Sondeo**: el job de cada minuto (`sweepPey`) marca los vencimientos y, con
  `PEY_MODE=http`, consulta `GET /bank-account/{id}` de las cuentas que no están activas y
  `GET /transaction/{id}` de los cobros pendientes. Es idempotente.

Los tests usan el mock o un `fetch` falso; nunca tocan la red.

## Hosting

Un contenedor chico en AWS App Runner (cuenta 355622872251, región us-east-2, perfil
`coperacha`) en `https://app.coperacha.app`: imagen del `Dockerfile` (Node 20, linux/amd64,
usuario sin privilegios, sin secretos), una instancia de 0.25 vCPU, store en S3 y secretos en
Secrets Manager (`coperacha-app/prod`).

```bash
AWS_PROFILE=coperacha infra/deploy.sh    # sólo con el OK de JI
```

Detalle de recursos, secreto y dominio en [infra/README.md](./infra/README.md). La cola de
salida de WhatsApp sigue en memoria: lo que esté encolado se pierde en cada deploy.

## Preguntas abiertas

- Verificar el WhatsApp de cada participante con un código (hoy se confía en el número
  escrito; fuera de alcance del MVP).
- Registry de Arturito: confirmar endpoint y payload de registro.
- Qué pasa si alguien no paga su cobro CoDi después de confirmar (reintento, recordatorio,
  reasignar).
- Mapeo de chats `@lid` a teléfonos (hoy se ignoran).
- Pasar el store a SQLite y la cola a algo persistente antes de producción.

## Notas de trabajo

Backlog: [docs/ROADMAP.md](./docs/ROADMAP.md). Estado actual: el plan de sesión más reciente
en [docs/sessions/](./docs/sessions/).
