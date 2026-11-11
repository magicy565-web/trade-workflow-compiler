# Changelog

## 0.2.0 — 2026-11-11

- Add buyer batch fan-out from one qualified research result, per-recipient run/approval, explicit selection, and atomic parent cancellation.
- Enforce shared original budget and authorization deadline; reject changed published workflow snapshots.
- Add durable receipt/correlation ownership, exact recipient validation, event inbox quarantine, early-event replay, pagination and recheck.
- Add disabled-by-default HMAC-signed ingress with timestamp validation, source-scoped ids and a real-file delivery CLI.
- Add batch controls and manual receipt reconciliation to the Chinese workbench.
- Add transactional schema 1 -> 2 migration and exercise upgrade using the supplied original v0.1 ZIP.
- External gateways, real OpenMausBot, provider email integrations, Temporal fan-out and browser E2E are NOT validated; see docs/verification.md.


## 0.1.0 — 2026-11-11

Initial independently runnable implementation:

- Strict three-playbook business compiler, bounded optional model selector and immutable WorkflowSpec.
- Capability binding/version hashes, graph dominators, contracts, approval and budget validation.
- SQLite persistence, workflow publishing, independent payload-bound approval, event inbox, audit chain and suppression.
- Crash-safe external dispatch boundary: ambiguous outcomes require reconciliation, never automatic resend.
- Original enterprise context passed to every worker; v1 single-recipient outbound execution.
- Native stdio OpenMausBot MCP adapter and authenticated/signed HTTP gateway client.
- Chinese local workspace UI, actual HTTP API integration tests and synthetic provider contract tests.
- Optional unverified Temporal scheduler source, Docker and GitHub Actions configuration.
- Local GitHub publishing helper; remote repository creation is not claimed by this release.

This version does not implement PostgreSQL, Zod, actual mail providers, autonomous online learning, general arbitrary workflow generation, or production multi-tenant SaaS operations. See verification records for precisely tested scope.
