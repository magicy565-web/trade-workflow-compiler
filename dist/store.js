import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, fail, hash } from './util.js';
import { EventInbox } from './events.js';
export const terminal = new Set(['COMPLETED', 'REJECTED', 'TIMED_OUT', 'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION']);
export class Store {
    db;
    constructor(path) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES('schema_version','1');
      CREATE TABLE IF NOT EXISTS definitions(tenant TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(tenant,id,version));
      CREATE TABLE IF NOT EXISTS runs(tenant TEXT NOT NULL,id TEXT PRIMARY KEY,request_key TEXT NOT NULL,body TEXT NOT NULL,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,UNIQUE(tenant,request_key));
      CREATE TABLE IF NOT EXISTS approvals(tenant TEXT NOT NULL,id TEXT PRIMARY KEY,run_id TEXT NOT NULL,node_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(tenant,run_id,node_id));
      CREATE TABLE IF NOT EXISTS events(tenant TEXT NOT NULL,id TEXT NOT NULL,event_type TEXT NOT NULL,correlation TEXT NOT NULL,received_at INTEGER NOT NULL,consumed_by TEXT,body TEXT NOT NULL,PRIMARY KEY(tenant,id));
      CREATE INDEX IF NOT EXISTS events_match ON events(tenant,event_type,correlation,received_at);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant TEXT NOT NULL,at INTEGER NOT NULL,actor TEXT NOT NULL,event_type TEXT NOT NULL,payload TEXT NOT NULL,previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS suppression(tenant TEXT NOT NULL,email TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(tenant,email));`);
        const row = this.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
        if (!['1', '2'].includes(row.value)) {
            this.db.close();
            fail('DB_VERSION', 'Unsupported database version');
        }
        // Additive, transactional v1 -> v2 migration. Preserve all original run JSON.
        this.transaction(() => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS batches(tenant TEXT NOT NULL,id TEXT PRIMARY KEY,source_run TEXT NOT NULL,request_key TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(tenant,source_run),UNIQUE(tenant,request_key));
                CREATE TABLE IF NOT EXISTS batch_members(tenant TEXT NOT NULL,batch_id TEXT NOT NULL,run_id TEXT NOT NULL,target_email TEXT NOT NULL,PRIMARY KEY(tenant,batch_id,target_email),UNIQUE(tenant,run_id));
                CREATE TABLE IF NOT EXISTS correlations(tenant TEXT NOT NULL,event_type TEXT NOT NULL,correlation TEXT NOT NULL,run_id TEXT NOT NULL,recipient TEXT,PRIMARY KEY(tenant,event_type,correlation));
                CREATE TABLE IF NOT EXISTS event_routes(tenant TEXT NOT NULL,event_id TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,run_id TEXT,PRIMARY KEY(tenant,event_id));
                CREATE INDEX IF NOT EXISTS event_routes_run ON event_routes(tenant,run_id,state);
                INSERT OR IGNORE INTO event_routes(tenant,event_id,state,reason,run_id) SELECT tenant,id,CASE WHEN consumed_by IS NULL THEN 'unmatched' ELSE 'consumed' END,NULL,consumed_by FROM events;
                UPDATE metadata SET value='2' WHERE key='schema_version';`);
        });
    }
    close() { this.db.close(); }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    audit(tenant, actor, type, payload) {
        const row = this.db.prepare('SELECT event_hash FROM audit ORDER BY seq DESC LIMIT 1').get();
        const previous = row?.event_hash ?? 'GENESIS', at = Date.now(), p = canonical(payload);
        const eventHash = hash({ tenant, actor, type, at, payload: p, previous });
        this.db.prepare('INSERT INTO audit(tenant,at,actor,event_type,payload,previous_hash,event_hash) VALUES(?,?,?,?,?,?,?)').run(tenant, at, actor, type, p, previous, eventHash);
    }
    verifyAudit() {
        const rows = this.db.prepare('SELECT * FROM audit ORDER BY seq').all();
        let previous = 'GENESIS';
        for (const r of rows) {
            if (r.previous_hash !== previous || r.event_hash !== hash({ tenant: r.tenant, actor: r.actor, type: r.event_type, at: r.at, payload: r.payload, previous }))
                return false;
            previous = r.event_hash;
        }
        return true;
    }
    auditLog(tenant) { return this.db.prepare('SELECT seq,at,actor,event_type,payload,event_hash FROM audit WHERE tenant=? ORDER BY seq DESC LIMIT 500').all(tenant); }
    saveDefinition(spec, actor) {
        if (spec.tenantId !== actor.tenantId)
            fail('TENANT', 'Tenant mismatch', 403);
        const d = { spec: structuredClone(spec), hash: hash(spec), author: actor.userId, status: 'draft' };
        this.transaction(() => {
            const existing = this.db.prepare('SELECT 1 FROM definitions WHERE tenant=? AND id=? AND version=?').get(actor.tenantId, spec.id, spec.version);
            if (existing)
                fail('IMMUTABLE_VERSION', 'Create a new version instead of overwriting', 409);
            this.db.prepare('INSERT INTO definitions VALUES(?,?,?,?)').run(actor.tenantId, spec.id, spec.version, JSON.stringify(d));
            this.audit(actor.tenantId, actor.userId, 'definition.created', { id: spec.id, version: spec.version, hash: d.hash });
        });
        return d;
    }
    getDefinition(tenant, id, version) {
        const row = this.db.prepare('SELECT body FROM definitions WHERE tenant=? AND id=? AND version=?').get(tenant, id, version);
        if (!row)
            fail('NOT_FOUND', 'Workflow version not found', 404);
        return JSON.parse(row.body);
    }
    listDefinitions(tenant) {
        return this.db.prepare('SELECT body FROM definitions WHERE tenant=? ORDER BY rowid DESC LIMIT 100').all(tenant).map(r => JSON.parse(r.body));
    }
    publish(tenant, id, version, expectedHash, actor) {
        return this.transaction(() => {
            const d = this.getDefinition(tenant, id, version);
            if (actor.tenantId !== tenant || actor.role !== 'approver')
                fail('FORBIDDEN', 'An approver is required', 403);
            if (d.hash !== expectedHash || hash(d.spec) !== expectedHash)
                fail('STALE_APPROVAL', 'Definition changed or hash mismatched', 409);
            if (d.spec.policy.fourEyes && d.author === actor.userId)
                fail('FOUR_EYES', 'The author cannot publish their own workflow', 403);
            if (d.status === 'published')
                return d;
            d.status = 'published';
            d.publishedBy = actor.userId;
            d.publishedAt = Date.now();
            this.db.prepare('UPDATE definitions SET body=? WHERE tenant=? AND id=? AND version=?').run(JSON.stringify(d), tenant, id, version);
            this.audit(tenant, actor.userId, 'definition.published', { id, version, hash: expectedHash });
            return d;
        });
    }
    createRun(tenant, workflowId, version, key, actor) {
        if (!/^[A-Za-z0-9_-]{16,80}$/.test(key))
            fail('IDEMPOTENCY_KEY', 'Use 16-80 letters, digits, underscores or hyphens');
        return this.transaction(() => {
            const prior = this.db.prepare('SELECT body FROM runs WHERE tenant=? AND request_key=?').get(tenant, key);
            if (prior) {
                const r = JSON.parse(prior.body);
                if (r.workflowId !== workflowId || r.version !== version)
                    fail('IDEMPOTENCY_CONFLICT', 'Key already belongs to a different request', 409);
                return r;
            }
            const d = this.getDefinition(tenant, workflowId, version);
            if (d.status !== 'published')
                fail('NOT_PUBLISHED', 'Publish the workflow before starting', 409);
            if (d.hash !== hash(d.spec))
                fail('INTEGRITY', 'Workflow hash mismatch', 409);
            const now = Date.now(), r = { id: randomUUID(), tenantId: tenant, workflowId, version, requestKey: key, createdBy: actor.userId, spec: d.spec, status: 'PENDING', current: d.spec.entry, steps: {}, reservedMicros: 0, actualMicros: 0, transitions: 0, createdAt: now, updatedAt: now, nextWakeAt: now };
            this.db.prepare('INSERT INTO runs(tenant,id,request_key,body) VALUES(?,?,?,?)').run(tenant, r.id, key, JSON.stringify(r));
            this.audit(tenant, actor.userId, 'run.created', { runId: r.id, workflowId, version });
            return r;
        });
    }
    getRun(tenant, id) {
        const row = this.db.prepare('SELECT body FROM runs WHERE tenant=? AND id=?').get(tenant, id);
        if (!row)
            fail('NOT_FOUND', 'Run not found', 404);
        return JSON.parse(row.body);
    }
    putRun(r) { r.updatedAt = Date.now(); this.db.prepare('UPDATE runs SET body=? WHERE tenant=? AND id=?').run(JSON.stringify(r), r.tenantId, r.id); }
    mutateRun(tenant, id, fn) { return this.transaction(() => { const r = this.getRun(tenant, id); fn(r); this.putRun(r); return r; }); }
    listRuns(tenant) {
        const rows = (tenant ? this.db.prepare('SELECT body FROM runs WHERE tenant=? ORDER BY rowid DESC LIMIT 500').all(tenant) : this.db.prepare('SELECT body FROM runs ORDER BY rowid DESC LIMIT 5000').all());
        return rows.map(r => JSON.parse(r.body));
    }
    acquire(tenant, id, owner, now) {
        const result = this.db.prepare('UPDATE runs SET lease_owner=?,lease_until=? WHERE tenant=? AND id=? AND lease_until<=?').run(owner, now + 180000, tenant, id, now);
        return Number(result.changes) === 1;
    }
    release(tenant, id, owner) { this.db.prepare('UPDATE runs SET lease_owner=NULL,lease_until=0 WHERE tenant=? AND id=? AND lease_owner=?').run(tenant, id, owner); }
    getApproval(tenant, id) {
        const row = this.db.prepare('SELECT body FROM approvals WHERE tenant=? AND id=?').get(tenant, id);
        if (!row)
            fail('NOT_FOUND', 'Approval not found', 404);
        return JSON.parse(row.body);
    }
    approvalFor(tenant, runId, nodeId) {
        const row = this.db.prepare('SELECT body FROM approvals WHERE tenant=? AND run_id=? AND node_id=?').get(tenant, runId, nodeId);
        return row ? JSON.parse(row.body) : undefined;
    }
    createApproval(a) { this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?)').run(a.tenantId, a.id, a.runId, a.nodeId, JSON.stringify(a)); }
    listApprovals(tenant) {
        return this.db.prepare('SELECT body FROM approvals WHERE tenant=? ORDER BY rowid DESC LIMIT 500').all(tenant).map(r => JSON.parse(r.body));
    }
    decideApproval(tenant, id, expectedHash, approved, actor, now = Date.now()) {
        return this.transaction(() => {
            const a = this.getApproval(tenant, id), run = this.getRun(tenant, a.runId);
            if (actor.role !== 'approver' || actor.tenantId !== tenant)
                fail('FORBIDDEN', 'An approver is required', 403);
            if (run.spec.policy.fourEyes && run.createdBy === actor.userId)
                fail('FOUR_EYES', 'Run initiator cannot approve outbound content', 403);
            if (a.payloadHash !== expectedHash || hash(a.payload) !== expectedHash)
                fail('STALE_APPROVAL', 'Payload hash mismatch', 409);
            if (a.state !== 'pending') {
                if (a.state === (approved ? 'approved' : 'rejected') && a.decidedBy === actor.userId)
                    return a;
                fail('ALREADY_DECIDED', 'Approval decision is immutable', 409);
            }
            if (a.expiresAt <= now || terminal.has(run.status))
                fail('EXPIRED', 'Approval is expired or run is closed', 409);
            a.state = approved ? 'approved' : 'rejected';
            a.decidedBy = actor.userId;
            a.decidedAt = now;
            this.db.prepare('UPDATE approvals SET body=? WHERE tenant=? AND id=?').run(JSON.stringify(a), tenant, id);
            run.nextWakeAt = now;
            this.putRun(run);
            this.audit(tenant, actor.userId, 'approval.' + a.state, { approvalId: id, runId: a.runId, payloadHash: expectedHash });
            return a;
        });
    }
    ingest(e, actor) {
        return new EventInbox(this).ingest(e, actor);
    }
    matchingEvent(tenant, type, correlation, after, through) {
        const row = this.db.prepare(`SELECT e.body FROM events e JOIN event_routes r ON r.tenant=e.tenant AND r.event_id=e.id
            WHERE e.tenant=? AND e.event_type=? AND e.correlation=? AND e.received_at>=? AND e.received_at<=? AND e.consumed_by IS NULL AND r.state='ready' ORDER BY e.received_at,e.id LIMIT 1`).get(tenant, type, correlation, after, through);
        return row ? JSON.parse(row.body) : undefined;
    }
    consumeEvent(e, runId) {
        const changed = Number(this.db.prepare('UPDATE events SET consumed_by=? WHERE tenant=? AND id=? AND consumed_by IS NULL').run(runId, e.tenantId, e.id).changes) === 1;
        if (changed)
            this.db.prepare("UPDATE event_routes SET state='consumed',run_id=? WHERE tenant=? AND event_id=?").run(runId, e.tenantId, e.id);
        return changed;
    }
    suppress(tenant, email, reason, actor) {
        this.transaction(() => { this.db.prepare('INSERT INTO suppression VALUES(?,?,?,?) ON CONFLICT(tenant,email) DO UPDATE SET reason=excluded.reason,at=excluded.at').run(tenant, email.toLowerCase(), reason, Date.now()); this.audit(tenant, actor.userId, 'recipient.suppressed', { email: email.toLowerCase(), reason }); });
    }
    isSuppressed(tenant, email) { return !!this.db.prepare('SELECT 1 FROM suppression WHERE tenant=? AND email=?').get(tenant, email.toLowerCase()); }
}
//# sourceMappingURL=store.js.map