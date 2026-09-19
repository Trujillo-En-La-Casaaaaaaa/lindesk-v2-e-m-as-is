The provided ShopFlow repositories form an existing full-stack system.

Implement customer order cancellation while preserving the existing architecture, repository responsibilities, and Hexagonal Architecture boundaries.

Do not redesign the system unless a change is strictly required to implement the feature correctly.

FUNCTIONAL REQUIREMENTS

A customer must be able to cancel an order that has not been shipped.

Cancellation must:

1. Require a non-empty cancellation reason.
2. Reject a reason longer than 200 characters.
3. Change the order status to CANCELLED.
4. Store cancelledAt.
5. Store cancellationReason.
6. Restore inventory exactly once.
7. Send a cancellation notification through the existing notification integration.
8. Reject cancellation of SHIPPED orders.
9. Safely handle repeated cancellation requests without restoring inventory twice.
10. Be exposed through the existing frontend.
11. Include automated tests.

Preserve all existing functionality.

Respect the responsibilities of:

- shopflow-web;
- shopflow-api;
- shopflow-infra.

Preserve the Hexagonal Architecture of shopflow-api.

Do not perform unrelated refactoring.
Do not create additional repositories.
Do not add unrelated functionality.
