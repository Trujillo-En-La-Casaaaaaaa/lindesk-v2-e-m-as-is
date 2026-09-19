# ShopFlow — E-M (AS-IS → resultado)

Este repositorio muestra la **evolución** como historial de Git (dos commits):

1. Tag [`as-is`](https://github.com/Trujillo-En-La-Casaaaaaaa/lindesk-v2-e-m-as-is/tree/as-is) — fixture congelado, **antes** de LinDesk.
2. Rama `main` (este árbol) — resultado de LinDesk, corrida `20260919-002726`.

**Diff:** https://github.com/Trujillo-En-La-Casaaaaaaa/lindesk-v2-e-m-as-is/compare/as-is...main

El encargo congelado está en [`TASK.md`](./TASK.md). Este paquete es solo código fuente.

---

# ShopFlow — evolución · complejidad media (E-M)

Paquete de entrevista (artefacto congelado). Contiene el árbol de ShopFlow del escenario **E-M**. **No es LinDesk**; es el software de dominio que se evalúa.

## Qué es ShopFlow

ShopFlow es una aplicación pequeña de **comercio electrónico / gestión de pedidos**. Es el dominio compartido de los nueve escenarios (no es LinDesk). El comportamiento de negocio previsto es:

1. Catálogo de productos.
2. Inventario (stock).
3. Creación de pedidos.
4. Validar inventario **antes** de aceptar un pedido.
5. Decrementar inventario **después** de un pedido exitoso.
6. Consulta de detalle / estado del pedido.
7. Acción administrativa para marcar un pedido como `SHIPPED`.
8. Notificación de confirmación del pedido.

Según el escenario, se pide además **cancelación de pedido por el cliente** (creación y evolución) o se prohíbe expresamente (migración).

Reglas de cancelación cuando sí aplica:

- el pedido no debe estar `SHIPPED`;
- motivo no vacío y de como máximo 200 caracteres;
- pasar a `CANCELLED`;
- guardar `cancelledAt` y `cancellationReason`;
- restaurar inventario **exactamente una vez**;
- enviar o registrar una notificación de cancelación;
- rechazar cancelar un pedido ya enviado;
- reintentos repetidos no deben restaurar stock dos veces.


## Este escenario (E-M)

| | |
|---|---|
| Código | `E-M` |
| Ciclo de vida | Evolución (se parte de un ShopFlow ya existente) |
| Complejidad arquitectónica | Media — preservar tres repositorios y hexagonal |
| Identificador de corrida | `20260919-002726` (solo trazabilidad) |

Baseline **antes** de LinDesk (AS-IS): https://github.com/Trujillo-En-La-Casaaaaaaa/lindesk-v2-e-m-as-is

Inspeccione primero el AS-IS y después este resultado.


### Arquitectura pedida

El baseline ya separa `shopflow-web`, `shopflow-api` (hexagonal) y `shopflow-infra`. Hay que conservar responsabilidades y fronteras hexagonales. No rediseñar salvo lo estrictamente necesario para la cancelación.

### Encargo (resumen)

Añadir **cancelación de pedido** en frontend, API e integración de notificaciones ya existentes, con pruebas. Preservar funcionalidad previa. Sin repositorios nuevos, sin refactor no relacionado.

El texto **exacto** del encargo está en [`TASK.md`](./TASK.md). Úselo como contrato.

### Carpetas de este árbol

- `shopflow-web/` — frontend existente.
- `shopflow-api/` — API hexagonal existente.
- `shopflow-infra/` — Compose y emulador existentes.

## Cómo usarlo en la entrevista

1. Lea primero `TASK.md` (el encargo congelado; está en inglés porque así se le dio al sistema).
2. Recorra los directorios de producto listados arriba. Este paquete es **solo código fuente** (sin `node_modules`, builds ni informes de análisis).
3. Juzgue el código frente al encargo: requisitos funcionales **y** restricciones arquitectónicas. Un sistema que “parece funcionar” pero ignora los límites del escenario no cumple el contrato.
4. No trate este README como veredicto de calidad: es contexto. La puntuación es del experto sobre el código.
5. Etapa B (`AGENTS.md`, grafo C4) **no** está en este repositorio. LinDesk en ejecución se muestra por RDP, aparte de este árbol de GitHub.

