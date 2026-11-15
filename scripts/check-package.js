import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import info from '../package.json' with { type: 'json' };

const archive = resolve(process.argv[2] ?? `4onv-scan-coverage-audit-${info.version}.tgz`);
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run check:package.');
const dir = mkdtempSync(join(tmpdir(), 'scan-coverage-install-'));

function run(...args) {
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 45_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ''));
  return result.stdout.trim();
}

try {
  const filename = basename(archive);
  copyFileSync(archive, join(dir, filename));
  const json = run('--prefix', '.', 'exec', '--offline', '--yes', `--package=./${filename}`,
    '--', 'scan-coverage-audit', 'demo', '--json');
  const report = JSON.parse(json);
  assert.equal(report.synthetic, true);
  assert.equal(report.counts.scanned, 1);
  assert.deepEqual(report.gaps.map(x => x.status), ['skipped', 'missing', 'error']);
  run('install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive);
  assert.equal(run('exec', '--offline', '--', 'scan-coverage-audit', '--version'), info.version);
  console.log('Verified the offline quick start and installed the archive.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
