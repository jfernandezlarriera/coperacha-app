# infra

Despliegue de la app en AWS App Runner, en `https://app.coperacha.app`. **Desplegar requiere
el OK de JI**: nadie (persona o agente) corre este script sin su aprobación explícita.

## Cómo se corre

```bash
AWS_PROFILE=coperacha AWS_REGION=us-east-2 infra/deploy.sh
APPLY_DNS=1 AWS_PROFILE=coperacha infra/deploy.sh   # además escribe los registros de app.coperacha.app en Route 53
```

Hace falta `aws`, `docker`, `git` y `node` en la máquina, y el árbol de git limpio (la imagen
se etiqueta con el sha corto del commit). El script es idempotente: lo que existe se
actualiza y lo que falta se crea. Verifica que las credenciales sean de la cuenta
`355622872251` antes de tocar nada.

## Antes de la primera vez

El secreto `coperacha-app/prod` (Secrets Manager, us-east-2) tiene que existir; lo carga JI
aparte. El script **no lo crea ni lo modifica** y falla con un mensaje claro si falta o si le
faltan llaves. Es un objeto JSON con estas llaves:

- Obligatorias: `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REDIRECT_URI` (`https://app.coperacha.app/auth/google/callback`), `ARTURITO_PHONE`,
  `ARTURITO_SEND_URL`, `ARTURITO_SEND_KEY`, `ARTURITO_WEBHOOK_TOKEN`,
  `ARTURITO_SEND_LIMIT_PER_MINUTE`.
- También requeridos para `PEY_MODE=http`: `PEY_API_KEY`, `PEY_WEBHOOK_SECRET`.
- Opcional: `PEY_API_URL` (si falta, la app usa `https://api.pey.mx`).

Para revisar las llaves el script lee el secreto y compara sólo los nombres; los valores no
se imprimen ni se guardan. App Runner los inyecta como variables de entorno al arrancar.

## Recursos (cuenta 355622872251, us-east-2)

| Recurso | Nombre |
| --- | --- |
| Repositorio ECR | `coperacha-app` (tags: sha corto y `latest`) |
| Servicio App Runner | `coperacha-app` (0.25 vCPU, 0.5 GB, puerto 3000, health check HTTP `/health`, sin auto-deploy) |
| Auto scaling | `coperacha-app-single` (mínimo 1, máximo 1) |
| Rol de instancia | `coperacha-app-instance` (lee el secreto; Get/Put del objeto de datos) |
| Rol de acceso a ECR | `coperacha-app-ecr-access` (pull de la imagen) |
| Bucket de datos | `coperacha-app-data-355622872251`, objeto `prod/coperacha.json` (privado, versionado) |
| Secreto | `coperacha-app/prod` (sólo lectura) |
| Dominio | `app.coperacha.app` en la zona `Z07840041NPPNHYPB4RR2` |

Las políticas IAM están en `infra/policies/` con marcadores (`__SECRET_ARN__`, `__BUCKET__`,
`__KEY__`, `__REPO_ARN__`) que el script reemplaza. El único `Resource: "*"` es
`ecr:GetAuthorizationToken`, que no admite otro recurso.

Variables no secretas que configura el script: `PORT=3000`,
`APP_BASE_URL=https://app.coperacha.app`, `COOKIE_SECURE=true`,
`APP_TIMEZONE=America/Mexico_City`, `PEY_MODE=http`, `AUTH_DEV_LOGIN=false`, `AWS_REGION`,
`DATABASE_S3_BUCKET`, `DATABASE_S3_KEY`.

## Dominio

El script asocia `app.coperacha.app` (sin `www`) e imprime los registros CNAME que hay que
agregar: el del dominio y los de validación del certificado. Con `APPLY_DNS=1` los escribe
con `UPSERT` en la zona, y se niega a escribir cualquier nombre que no sea
`app.coperacha.app` o esté debajo de él; el apex `coperacha.app` (la landing) no se toca. Si
los registros de validación todavía no aparecen, se vuelve a correr en un minuto.

## Una sola instancia

El store vive en memoria y se copia a S3 después de cada cambio, con un solo escritor. Por
eso el auto scaling queda fijo en una instancia: con dos, la última en escribir pisaría a la
otra. El bucket tiene versionado para poder volver a una copia anterior del objeto.
