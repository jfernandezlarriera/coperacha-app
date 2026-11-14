# Plan de sesión — coperacha-app

**Branch**: main (cambios sin commitear en el working tree)
**Actualizado**: 2026-11-14

## Estado actual

MVP del regalo sorpresa todo o nada construido de cero en esta sesión: dominio, web, WhatsApp
(Arturito) y CoDi (Pey) detrás de interfaces con mocks, 33 tests en verde con `npm test`.
Sin dependencias de npm porque `npm install` no estaba permitido en la sesión; el store es un
archivo JSON con interfaz de repositorio para migrar a SQLite.

## En progreso

- Nada en curso; falta revisión de JI y commit.

## 🔴 Bloqueadores

- `env.example` debe renombrarse a `.env.example` a mano (ver ROADMAP P0).

## Próximos pasos

1. Revisar el diff, correr `npm test` y `npm start`, probar el recorrido del README.
2. Commit en `main` (política `direct` del área).
3. Confirmar formas reales de Pey y del registry de Arturito.

## Decisiones pendientes

- **Q1**: ¿Store a SQLite ahora (better-sqlite3) o esperar a Node 22 con `node:sqlite`? — afecta hosting.
- **Q2**: ¿El total en curso debe incluir los topes privados al valor provisional (como hoy) o excluirlos hasta confirmar? — afecta privacidad con pocos participantes.
- **Q3**: ¿Confirmación manual del organizador al llegar a la meta (como hoy) o cobro automático? — afecta copy y notificaciones.

## Cross-repo deps

- Arturito (`aie-whatsapp`): contrato de send ya existe; registry y forma del evento entrante por confirmar.
- `coperacha-landing`: colores y tono; sin dependencia de código.

## Histórico

- 2026-11-14: MVP inicial (esta sesión).
