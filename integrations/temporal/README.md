# Optional Temporal scheduler — integration NOT live-validated

This is an implemented optional scheduler, not the default runtime and not a claim that Temporal has been deployed. The delivery environment could not resolve npm hosts and has no Temporal service. SDK installation, compilation against the real SDK, and live Temporal recovery tests remain unverified. Core test counts do not include this package.

The adapter uses real Temporal Workflows, Activities, durable waits, a wake signal and continue-as-new. It advances the existing TWC state machine through the authenticated worker API. It does **not** bypass approvals or send commercial actions directly. TWC SQLite remains the business journal; this is not a PostgreSQL migration or a horizontally scalable runtime.

1. Start a local/self-hosted Temporal service (port 7233).
2. In the main application's `.env`, set `TWC_SCHEDULER=external`, then restart it. Do not run the embedded scheduler as well.
3. Copy this directory's `.env.example` to `.env` and set `TWC_WORKER_TOKEN` to the **worker** credential for the enterprise. Never use an approver token here.
4. From this directory: `npm install --ignore-scripts`, `npm run build`, `npm start`.
5. Start a published run in the normal TWC interface. This worker discovers active runs and creates a Temporal Workflow using a tenant/run-derived ID. A second scan cannot start a duplicate active Workflow.
6. Approve/reject or deliver events through TWC normally. The Workflow resumes by its durable poll (at most 30 seconds); `wake` is optional, not required for correctness.

The discovery loop intentionally catches and reports errors instead of silently falling back to local execution. HTTP/TWC outages are retried through Activity policy. Ambiguous commercial dispatches remain `NEEDS_RECONCILIATION`. After human reconciliation the scanner can create another execution for the same Workflow ID using `ALLOW_DUPLICATE` for **closed**, not running, executions.

Before deployment: verify against the pinned SDK; test worker termination/restart, API loss after acceptance, approval rejection and reconciliation; configure Temporal TLS/auth, history encryption, backups and access control. A local no-auth Temporal dev server must never be exposed publicly.
