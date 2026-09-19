# ShopFlow API

Node.js and TypeScript HTTP API using Hexagonal Architecture.

- `src/domain`: framework-independent entities and rules.
- `src/application`: use cases.
- `src/ports`: interfaces owned by the core.
- `src/adapters`: Express, PostgreSQL, and notification provider implementations.

## Local checks

```sh
npm ci
npm test
npm run build
```

The complete system is started from `../shopflow-infra`. API routes are `GET /products`, `POST /orders`, `GET /orders/:id`, `POST /admin/orders/:id/ship`, and `POST /orders/:id/cancel`.

## Cancellation

`POST /orders/:id/cancel` with `{ "reason": "<string>" }` cancels an order that has not been
shipped, restores its inventory exactly once, and sends an `ORDER_CANCELLATION` message
through the notification provider. The reason is required and limited to 200 characters
after trimming. A `SHIPPED` order is rejected with `409 INVALID_STATUS`, an unknown order
with `404 NOT_FOUND`, and a missing, blank, or over-long reason with `400 INVALID`.
Cancelling an already cancelled order is a safe no-op that returns the existing order
without restoring stock or notifying a second time.

The real-PostgreSQL persistence and concurrency evidence runs when `DATABASE_URL` is set
(otherwise it reports an explicit skip):

```sh
DATABASE_URL=postgres://shopflow:shopflow@localhost:5432/shopflow npm test
```
