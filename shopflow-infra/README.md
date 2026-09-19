# ShopFlow Infrastructure

Docker Compose runs the complete local system: React web, Node API, PostgreSQL, and the deterministic HTTP notification emulator.

## Start

From this repository, run the single command:

```sh
docker compose up --build
```

Open <http://localhost:3000>. The API is also exposed at <http://localhost:3001>, and recorded notifications can be inspected at <http://localhost:4010/notifications>.

Recorded notifications include both message types:

- `ORDER_CONFIRMATION` — written when an order is created.
- `ORDER_CANCELLATION` — written when a `CONFIRMED` order is cancelled; the record also carries the `reason`.

## Data model

The `orders` table accepts the statuses `CONFIRMED`, `SHIPPED`, and `CANCELLED`, and stores cancellation details in the nullable `cancelled_at` (`TIMESTAMPTZ`) and `cancellation_reason` (`TEXT`) columns. Only `CONFIRMED` orders can be cancelled; a cancelled order is never shipped and repeated cancellation attempts are no-ops that restore inventory only once.

Deterministic database seeds:

- Product A: ID `product-a`, SKU `SKU-A`, stock `10`
- Product B: ID `product-b`, SKU `SKU-B`, stock `5`

The schema in `postgres/init.sql` is applied only when the Postgres data volume is first initialized, so an existing volume keeps its old schema. To restore the exact seed state and the current schema, run `docker compose down -v` before starting again. All services are local; no cloud service or internet connection is used at runtime.

## Verification

`verify/cancellation.sh` is a dependency-free black-box check (POSIX `sh`, `curl`, `grep`, `sed`, `wc`; the schema assertions additionally use `docker compose exec db`) of the whole cancellation feature. It polls each service `/health` before asserting, and exits non-zero as soon as any assertion fails.

```sh
docker compose down -v
docker compose up --build -d
docker compose ps                 # all services healthy/running
./verify/cancellation.sh          # expected exit code 0
docker compose down -v
```

On Windows the script runs under Git Bash or WSL, for example:

```sh
"C:/Program Files/Git/bin/bash.exe" verify/cancellation.sh
```

It asserts, against a freshly initialized stack:

1. The `orders` schema allows `CANCELLED` and has the nullable `cancelled_at` / `cancellation_reason` columns, and the seeds are intact.
2. Creating an order decrements stock and records exactly one `ORDER_CONFIRMATION`.
3. Cancelling with a reason returns the order with `status` `CANCELLED` and a non-null `cancelledAt`, restores stock, and records exactly one `ORDER_CANCELLATION` carrying the reason.
4. Cancelling the same order again is a safe no-op: stock stays restored once and no second `ORDER_CANCELLATION` is recorded.
5. An empty reason and a 201-character reason are rejected with `400`, with no stock or notification side effects.
6. Cancelling a `SHIPPED` order returns `409` and does not restore stock.
7. Cancelling an unknown order id returns `404`.
8. Two concurrent cancellations of the same order both return `200`, restore inventory exactly once, and record a single `ORDER_CANCELLATION`.
9. The emulator rejects a missing `type`, an unknown `type`, and a missing `orderId` with `400`, and records both accepted message types.
10. The storefront is served with HTTP `200` on <http://localhost:3000>. Manual browser confirmation of the cancel action itself is not performed by the script; the UI is covered by the `shopflow-web` unit tests.
