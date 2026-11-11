#!/usr/bin/env node
// Explicit file enumeration works on Windows as well as POSIX shells.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const tests = readdirSync(new URL('../test/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => `test/${name}`);
if (!tests.length) throw new Error('No test files found');
const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: root, stdio: 'inherit', shell: false
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
