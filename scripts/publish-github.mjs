#!/usr/bin/env node
// Runs on the user's own computer with their existing GitHub CLI authentication.
// Creates ONE new repository. Never overwrites a repository or force-pushes.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
// fileURLToPath is necessary on Windows and for paths containing spaces/non-ASCII names.
const { fileURLToPath } = await import('node:url');
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
if (args.some(a => a !== '--public'))
    throw Error('Only --public is supported; default visibility is private');
const owner = 'magicy565-web', name = 'trade-workflow-compiler', full = `${owner}/${name}`;
function run(command, args, capture = false, allowFailure = false) { const r = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', shell: false }); if (r.error)
    throw Error(`${command} is unavailable. Install it locally first. ${r.error.message}`); if (r.status !== 0 && !allowFailure)
    throw Error(`${command} failed; stopped without force-pushing.`); return r; }
try {
    run('git', ['--version']);
    run('gh', ['--version']);
    run('gh', ['auth', 'status']);
    const login = run('gh', ['api', 'user', '--jq', '.login'], true).stdout.trim();
    if (login !== owner)
        throw Error(`Authenticated as ${login}, expected ${owner}. Switch accounts locally before publishing.`);
    const existing = run('gh', ['api', `repos/${full}`, '--silent'], true, true);
    if (existing.status === 0)
        throw Error(`${full} already exists. No files were pushed or overwritten.`);
    if (!/404/.test(existing.stderr))
        throw Error('Could not confirm repository absence; refusing to create on an ambiguous network/permission error.');
    const tests = readdirSync('test').filter(n => n.endsWith('.test.mjs')).map(n => 'test/' + n);
    run(process.execPath, ['--test', ...tests]);
    if (!existsSync('.git'))
        run('git', ['init', '-b', 'main']);
    const top = run('git', ['rev-parse', '--show-toplevel'], true).stdout.trim();
    if (realpathSync(top) !== realpathSync(process.cwd()))
        throw Error('Refusing to publish from inside a different parent repository');
    const remotes = run('git', ['remote'], true).stdout.trim();
    if (remotes)
        throw Error('Existing git remotes found. Refusing to replace or reuse them automatically.');
    const branch = run('git', ['branch', '--show-current'], true).stdout.trim();
    if (branch !== 'main')
        throw Error('Expected main branch; refusing to rename an existing branch automatically');
    if (run('git', ['config', 'user.name'], true, true).status !== 0)
        run('git', ['config', 'user.name', owner]);
    if (run('git', ['config', 'user.email'], true, true).status !== 0)
        run('git', ['config', 'user.email', '233131300+magicy565-web@users.noreply.github.com']);
    const allow = ['src', 'dist', 'public', 'config', 'docs', 'test', 'integrations', 'schemas', 'scripts', 'reports', '.github', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', '.dockerignore', 'Dockerfile', 'compose.yaml', '.env.example', 'package.json', 'tsconfig.json'];
    run('git', ['add', '--', ...allow.filter(existsSync)]);
    const tracked = run('git', ['ls-files'], true).stdout.split('\n').filter(Boolean);
    if (tracked.some(p => /(^|\/)(data|node_modules)\//.test(p) || /\.local\.json$|\.sqlite(?:-|$)|\.token$/.test(p) || /(^|\/)\.env(?:\.|$)/.test(p) && !p.endsWith('.env.example')))
        throw Error('Sensitive/local files are tracked. Remove them from the index before publishing.');
    const changes = run('git', ['diff', '--cached', '--quiet'], true, true);
    if (changes.status !== 0)
        run('git', ['commit', '-m', 'feat: initial trade workflow compiler v0.1.0']);
    run('gh', ['repo', 'create', full, args.includes('--public') ? '--public' : '--private', '--source=.', '--remote=origin', '--push', '--description', 'Self-hosted trade workflow compiler with evidence, approvals, durable execution and OpenMausBot integration']);
    run('gh', ['repo', 'view', full, '--json', 'url,isPrivate,nameWithOwner']);
    console.log('Repository created and pushed successfully. Verify the returned URL and GitHub Actions before deployment.');
}
catch (error) {
    console.error(error.message);
    console.error('No overwrite or force-push was attempted. If creation succeeded but upload failed, inspect the remote before retrying.');
    process.exitCode = 1;
}
