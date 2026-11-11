// Synthetic HTTP fixture; CLI must never call a sending endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pricingFixture, configured, pricingInput, viewerToken } from './pricing-helpers.mjs';
import { hash } from '../dist/util.js';
for (const variant of ['valid', 'withdrawn', 'wrong tenant', 'disabled']) test('quote preview CLI: ' + variant, async t => {
    const f = await pricingFixture(); t.after(f.close);
    const dir = mkdtempSync(join(tmpdir(), 'twc-preview-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const entries = configured(f.url).list();
    if (variant === 'disabled') entries.find(c => c.id === 'quote.import').enabled = false;
    if (variant === 'withdrawn') f.state.status = 409;
    writeFileSync(join(dir, 'request.json'), JSON.stringify(pricingInput(f.state.quote)));
    writeFileSync(join(dir, 'registry.json'), JSON.stringify(entries));
    const result = await new Promise((resolveResult, reject) => {
        const child = spawn(process.execPath, [resolve('dist/cli.js'), 'quote-preview', join(dir, 'request.json'),
            join(dir, 'registry.json'), variant === 'wrong tenant' ? 'other' : 'test-tenant'], { env: { ...process.env }, cwd: dir });
        let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
        child.on('error', reject); child.on('close', code => resolveResult({ code, out, err }));
    });
    assert(!JSON.stringify(result).includes(viewerToken));
    assert(f.state.paths.every(p => p.startsWith('GET /v1/me') || p === 'GET /v1/quotes/fixture-quote/customer'));
    if (variant === 'valid') {
        assert.equal(result.code, 0); const preview = JSON.parse(result.out);
        assert.equal(preview.authorizedToSend, false); assert.equal(preview.payloadHash, hash(preview.payload));
        assert.equal(preview.payload.quote.unit_price, '0.01234567');
    } else { assert.notEqual(result.code, 0); assert.equal(result.out, ''); }
});
