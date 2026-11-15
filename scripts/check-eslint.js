import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.argv[2], 'Pass the path to ESLint’s bin/eslint.js.');
const eslint = resolve(process.argv[2]);
const audit = fileURLToPath(new URL('../bin/scan-coverage-audit.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'scan-coverage-eslint-'));

function run(executable, args, status) {
  const result = spawnSync(executable, args, { cwd: dir, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, status, result.stderr || String(result.error ?? ''));
  return result.stdout;
}

try {
  writeFileSync(join(dir, 'eslint.config.mjs'), `export default [
    { ignores: ['ignored.js'] },
    { files: ['**/*.js'], rules: { 'no-unused-vars': 'error' } },
  ];\n`);
  writeFileSync(join(dir, 'checked.js'), 'const unused = 1;\n');
  writeFileSync(join(dir, 'syntax.js'), 'const oops = ;\n');
  writeFileSync(join(dir, 'ignored.js'), '/* synthetic ignored file */\n');
  writeFileSync(join(dir, 'missing.js'), '/* synthetic unpassed file */\n');
  run('git', ['init', '--template=', '--initial-branch=main'], 0);
  run('git', ['add', '-f', '--', '.'], 0);
  run('git', ['-c', 'user.name=Synthetic CI fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=.git/no-hooks', 'commit', '-qm', 'Synthetic baseline'], 0);
  const manifest = run(process.execPath, [audit, 'plan', '--ext', '.js'], 0);
  writeFileSync(join(dir, 'inventory.json'), manifest);
  run(process.execPath, [eslint, 'checked.js', 'syntax.js', 'ignored.js',
    '--format', 'json', '--output-file', 'eslint.json'], 1);
  const lint = JSON.parse(readFileSync(join(dir, 'eslint.json'), 'utf8'));
  assert.ok(lint.some(file => file.messages.some(message => message.ruleId === 'no-unused-vars')));
  const report = JSON.parse(run(process.execPath, [audit, 'check', 'inventory.json',
    '--eslint', 'eslint.json', '--report-root', dir, '--json'], 1));
  assert.deepEqual(report.counts, {
    expected: 4, scanned: 1, skipped: 1, error: 1, missing: 1, extra: 0, outsideRoot: 0, globalErrors: 0,
  });
  console.log('Real ESLint output accounted for one scanned, one skipped, one missing, and one errored file.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
