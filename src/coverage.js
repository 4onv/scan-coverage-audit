import { posix, win32 } from 'node:path';
import { maxPaths, repoPath, validateInventory } from './inventory.js';

const statuses = new Set(['scanned', 'skipped', 'error']);
const windowsRoot = /^(?:[a-z]:[\\/]|\\\\)/iu;

function scanPath(value, root) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 8192) {
    throw new Error('A scanner path is missing, invalid, or too long.');
  }
  const windows = windowsRoot.test(value) || windowsRoot.test(root ?? '');
  const flavor = windows ? win32 : posix;
  if (!flavor.isAbsolute(value)) {
    return repoPath((windows ? value.replaceAll('\\', '/') : value).replace(/^(?:\.\/)+/u, ''));
  }
  if (!root || !flavor.isAbsolute(root)) {
    throw new Error('Absolute scanner paths require --report-root with an absolute checkout path.');
  }
  const relative = flavor.relative(root, value);
  if (!relative || flavor.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${flavor.sep}`)) {
    return null;
  }
  return repoPath(windows ? relative.replaceAll('\\', '/') : relative);
}

function semgrep(report, add, globalError) {
  if (!Array.isArray(report?.paths?.scanned) || !Array.isArray(report.errors) ||
      (report.paths.skipped !== undefined && !Array.isArray(report.paths.skipped))) {
    throw new Error('Semgrep JSON must include paths.scanned and errors arrays.');
  }
  for (const path of report.paths.scanned) add(path, 'scanned');
  for (const item of report.paths.skipped ?? []) add(item?.path, 'skipped');
  for (const issue of report.errors) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error('Invalid Semgrep error record.');
    if (!issue.path || issue.path === 'NO FILE INFO YET') globalError();
    else add(issue.path, 'error');
  }
}

function eslint(report, add) {
  if (!Array.isArray(report)) throw new Error('ESLint JSON must be an array of file results.');
  for (const item of report) {
    if (!Array.isArray(item?.messages) || item.messages.some(message => !message || typeof message !== 'object')) {
      throw new Error('Invalid ESLint file result.');
    }
    const fatal = item.fatalErrorCount > 0 || item.messages.some(message => message.fatal === true);
    const ignored = item.messages.some(message => message.ruleId === null &&
      typeof message.message === 'string' && /^File ignored\b/u.test(message.message));
    add(item.filePath, fatal ? 'error' : ignored ? 'skipped' : 'scanned');
  }
}

function receipt(report, add, globalError) {
  if (report?.version !== 1 || !Array.isArray(report.files) ||
      (report.globalErrors !== undefined && (!Number.isInteger(report.globalErrors) ||
        report.globalErrors < 0 || report.globalErrors > maxPaths))) {
    throw new Error('Expected a version 1 scanner receipt with a files array.');
  }
  for (const row of report.files) add(repoPath(row?.path), row.status);
  globalError(report.globalErrors ?? 0);
}

const readers = { semgrep, eslint, receipt };

export function checkInventory(plan, reports, { reportRoot, failExtra = false } = {}) {
  const { files, commit } = validateInventory(plan);
  if (reportRoot !== undefined && !(windowsRoot.test(reportRoot) || posix.isAbsolute(reportRoot))) {
    throw new Error('--report-root must be an absolute checkout path.');
  }
  const expected = new Set(files);
  const observed = new Map();
  const extra = new Set();
  let outsideRoot = 0;
  let globalErrors = 0;
  let rows = 0;
  let reportCount = 0;

  for (const { format, data } of reports) {
    reportCount++;
    if (!Object.hasOwn(readers, format)) throw new Error('Unknown report format.');
    readers[format](data, (raw, status) => {
      if (++rows > maxPaths * 4) throw new Error('Reports exceed 600,000 path records.');
      if (!statuses.has(status)) throw new Error('A receipt status must be scanned, skipped, or error.');
      const path = scanPath(raw, reportRoot);
      if (path === null) {
        outsideRoot++;
      } else if (!expected.has(path)) {
        extra.add(path);
      } else {
        const state = observed.get(path) ?? new Set();
        state.add(status);
        observed.set(path, state);
      }
    }, (count = 1) => { globalErrors += count; });
  }
  if (!reportCount) throw new Error('Supply at least one scanner report.');

  const counts = { expected: files.length, scanned: 0, skipped: 0, error: 0, missing: 0,
    extra: extra.size, outsideRoot, globalErrors };
  const gaps = [];
  for (const path of files) {
    const state = observed.get(path);
    const status = state?.has('error') ? 'error' : state?.has('scanned') ? 'scanned' :
      state?.has('skipped') ? 'skipped' : 'missing';
    counts[status]++;
    if (status !== 'scanned') gaps.push({ path, status });
  }
  const ok = counts.scanned === counts.expected && !globalErrors && (!failExtra || (!extra.size && !outsideRoot));
  return { version: 1, commit, ok, counts, gaps, extra: [...extra].sort() };
}
