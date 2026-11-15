import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkInventory } from '../src/coverage.js';
import { inventory, jsonFile, validateInventory } from '../src/inventory.js';

const cli = fileURLToPath(new URL('../bin/scan-coverage-audit.js', import.meta.url));
const plan = (...files) => ({ version: 1, kind: 'scan-coverage-inventory', commit: 'a'.repeat(40), files });
const semgrep = (scanned, skipped = [], errors = []) => ({
  format: 'semgrep', data: { results: [], paths: { scanned, skipped }, errors },
});
const receipt = (files, globalErrors) => ({
  format: 'receipt', data: { version: 1, files, globalErrors },
});
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-coverage-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('zero findings can leave missing, skipped, and errored planned files', () => {
  const report = checkInventory(plan('a.js', 'b.js', 'c.js', 'd.js'), [
    semgrep(['a.js', 'd.js'], [{ path: 'b.js' }], [{ path: 'd.js' }]),
  ]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.counts, {
    expected: 4, scanned: 1, skipped: 1, missing: 1, error: 1, extra: 0, outsideRoot: 0, globalErrors: 0,
  });
  assert.deepEqual(report.gaps, [
    { path: 'b.js', status: 'skipped' }, { path: 'c.js', status: 'missing' }, { path: 'd.js', status: 'error' },
  ]);
});

test('merges report shards, deduplicates paths, and uses completed scans over skips', () => {
  const report = checkInventory(plan('a.js', 'b.js'), [
    semgrep(['./a.js', 'a.js'], [{ path: 'b.js' }]),
    receipt([{ path: 'b.js', status: 'scanned' }]),
  ]);
  assert.equal(report.ok, true);
  assert.equal(report.counts.scanned, 2);
});

test('scan-wide errors fail even with complete path coverage', () => {
  const report = checkInventory(plan('a.js'), [
    semgrep(['a.js'], [], [{ path: 'NO FILE INFO YET' }, { message: 'configuration error' }]),
    receipt([], 2),
  ]);
  assert.equal(report.counts.scanned, 1);
  assert.equal(report.counts.globalErrors, 4);
  assert.equal(report.ok, false);
});

test('ESLint accepts lint findings, but separates fatal parsing errors and ignored-file placeholders', () => {
  const report = checkInventory(plan('a.js', 'b.js', 'c.js', 'd.js'), [{
    format: 'eslint', data: [
      { filePath: 'C:\\checkout\\a.js', messages: [{ ruleId: 'no-unused-vars', severity: 2 }] },
      { filePath: 'C:\\checkout\\b.js', messages: [{ fatal: true }] },
      { filePath: 'C:\\checkout\\c.js', messages: [{ ruleId: null, message: 'File ignored by default.' }] },
      { filePath: 'C:\\checkout\\d.js', fatalErrorCount: 1, messages: [] },
    ],
  }], { reportRoot: 'C:\\checkout' });
  assert.equal(report.counts.scanned, 1);
  assert.deepEqual(report.gaps.map(x => x.status), ['error', 'skipped', 'error']);
});

test('extra paths are available for review and optionally fail the audit', () => {
  const reports = [semgrep(['/checkout/a.js', '/checkout/extra.js', '/checkout-other/b.js', '/secret/private.js'])];
  const report = checkInventory(plan('a.js'), reports, { reportRoot: '/checkout' });
  assert.equal(report.ok, true);
  assert.deepEqual(report.extra, ['extra.js']);
  assert.equal(report.counts.outsideRoot, 2);
  assert.doesNotMatch(JSON.stringify(report), /private|checkout-other/);
  assert.equal(checkInventory(plan('a.js'), reports, { reportRoot: '/checkout', failExtra: true }).ok, false);
});

test('rejects malformed input instead of interpreting it as an empty scan', () => {
  for (const report of [
    { format: 'semgrep', data: { results: [], errors: [] } },
    receipt([{ path: '../a.js', status: 'scanned' }]),
    receipt([{ path: 'a.js', status: 'done' }]),
    receipt([], -1),
  ]) {
    assert.throws(() => checkInventory(plan('a.js'), [report]));
  }
  assert.throws(() => checkInventory(plan('a.js'), [semgrep(['/absolute/a.js'])]), /--report-root/);
  assert.throws(() => checkInventory(plan('a.js'), []), /at least one/);
  assert.throws(() => validateInventory(plan('a.js', 'a.js')), /duplicate/);
  assert.throws(() => validateInventory(plan()), /nonempty/);
});

test('Git inventory pins committed paths with literal folder and suffix filters', t => {
  const dir = temp(t);
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=.git/no-hooks', '-c', 'commit.gpgSign=false',
      '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--template=', '--initial-branch=main');
  for (const file of ['src/café space.js', 'src/decl.d.ts', 'src-extra/other.js', 'src/info.md']) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'synthetic\n');
  }
  git('add', '-f', '--', '.');
  git('commit', '-m', 'Synthetic baseline');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'src', 'future.js'), 'uncommitted\n');
  git('add', '-f', '--', 'src/future.js');
  const options = { ref: base, extensions: ['.js', '.d.ts'], under: ['src/'] };
  assert.deepEqual(inventory(join(dir, 'src'), options), { ...plan('src/café space.js', 'src/decl.d.ts'), commit: base });
  assert.throws(() => inventory(dir, { under: ['absent'] }), /No tracked/);
  assert.throws(() => inventory(dir, { ref: '--help' }), /git rev-parse failed/);
});

test('JSON accepts UTF-8 BOM and rejects malformed files and non-files', t => {
  const dir = temp(t);
  const file = join(dir, 'manifest.json');
  writeFileSync(file, '\ufeff{"ok":true}');
  assert.deepEqual(jsonFile(file, 'Fixture'), { ok: true });
  writeFileSync(file, Buffer.from([0xff]));
  assert.throws(() => jsonFile(file, 'Fixture'), /valid UTF-8 JSON/);
  assert.throws(() => jsonFile(dir, 'Fixture'), /regular file|EISDIR/);
});

test('CLI produces stable JSON and distinct success, gap, and invalid-input exits', t => {
  const dir = temp(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan('a.js', 'b.js')));
  writeFileSync(join(dir, 'one.json'), JSON.stringify(receipt([{ path: 'a.js', status: 'scanned' }]).data));
  writeFileSync(join(dir, 'two.json'), JSON.stringify(receipt([{ path: 'b.js', status: 'scanned' }]).data));
  const gap = run('check', 'plan.json', '--receipt', 'one.json', '--json');
  assert.equal(gap.status, 1);
  assert.equal(JSON.parse(gap.stdout).counts.missing, 1);
  const pass = run('check', 'plan.json', '--receipt', 'one.json', '--receipt', 'two.json');
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /PASS  2\/2/);
  assert.equal(run('check', 'plan.json').status, 2);
  const demo = run('demo', '--json');
  assert.equal(demo.status, 0);
  assert.equal(JSON.parse(demo.stdout).synthetic, true);
});
