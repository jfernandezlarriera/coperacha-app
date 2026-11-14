# Roadmap — coperacha-app

## P0 (bloquea lanzamiento)

- [ ] [operator-only] Renombrar `env.example` a `.env.example` (la sesión que lo creó no podía escribir rutas `.env*`).
- [ ] [operator-only] Confirmar con Pey la forma real de `POST /charges` y del webhook (campos, firma, estados) y ajustar `HttpPeyClient`.
- [ ] [operator-only] Confirmar el endpoint y payload del registry de Arturito; apuntar `ARTURITO_REGISTER_URL`.
- [ ] [claude-can-do] Pasar `Store` a SQLite (misma interfaz) y la cola de salida a algo persistente.
- [ ] [claude-can-do] Mapear chats `@lid` a participantes (hoy se ignoran).

## P1 (antes de escalar)

- [ ] [claude-can-do] Recordatorio y reintento para cobros CoDi pendientes después de confirmar.
- [ ] [claude-can-do] Verificación del WhatsApp del participante con código (pregunta abierta en el README).
- [ ] [claude-can-do] Rate limit básico en `/c/<code>/join` y en los webhooks.
- [ ] [operator-only] Hosting en AWS (contenedor chico, us-east-2, perfil `coperacha`) con OIDC; sólo con OK de JI.

## P2 (deseable)

- [ ] [claude-can-do] Página pública de «cómo funciona» enlazada desde la landing.
- [ ] [claude-can-do] Exportar resumen de la colecta confirmada (CSV) para el organizador.

## Done

- [x] (2026-11-14) MVP: auth Google + stub local, colectas, sumarse (fijo / parte igual / mayoría con tope), votación, todo o nada con cobros Pey (mock), salidas al vencer, WhatsApp por Arturito con cola 6/min y webhook con Bearer, 33 tests.
