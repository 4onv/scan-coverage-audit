import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

const decoder = new TextDecoder('utf-8', { fatal: true });
const commitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
export const maxPaths = 150_000;

export function repoPath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 ||
      /[\\\u0000]/u.test(value) || /^[a-z]:/iu.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Expected a canonical repository-relative path using forward slashes.');
  }
  return value;
}

export function jsonFile(path, label) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) {
      throw new Error(`${label} must be a regular file no larger than 32 MiB.`);
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw new Error(`${label} changed during the read.`);
    try {
      return JSON.parse(decoder.decode(bytes.subarray(0, length)));
    } catch {
      throw new Error(`${label} must contain valid UTF-8 JSON.`);
    }
  } finally {
    closeSync(fd);
  }
}

const gitLocation = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']);

function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !gitLocation.has(key.toUpperCase())));
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd, env: { ...env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 32 * 1024 * 1024, timeout: 30_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} failed. Check the repository, revision, and Git availability.`);
  }
  try {
    return decoder.decode(result.stdout);
  } catch {
    throw new Error('Git returned a path that is not valid UTF-8.');
  }
}

export function validateInventory(value) {
  if (value?.version !== 1 || value.kind !== 'scan-coverage-inventory' ||
      typeof value.commit !== 'string' || !commitId.test(value.commit) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > maxPaths) {
    throw new Error('Expected a version 1 Git inventory with a full commit ID and a nonempty files array.');
  }
  const files = new Set(value.files.map(repoPath));
  if (files.size !== value.files.length) throw new Error('The inventory contains duplicate paths.');
  return { commit: value.commit, files: [...files].sort() };
}

export function inventory(cwd, { ref = 'HEAD', extensions = [], under = [] } = {}) {
  if (extensions.some(ext => !/^\.[a-z0-9._+-]+$/iu.test(ext))) {
    throw new Error('Extensions must start with a dot, such as .js or .d.ts.');
  }
  const folders = under.map(path => repoPath(path.replace(/\/$/u, '')));
  const commit = git(cwd, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  if (!commitId.test(commit)) throw new Error('Git did not return a full commit ID.');
  const tree = git(cwd, 'ls-tree', '-r', '-z', '--full-tree', commit);
  if (tree && !tree.endsWith('\0')) throw new Error('Git returned malformed tree output.');
  const files = [];
  for (const row of tree.slice(0, -1).split('\0').filter(Boolean)) {
    const delimiter = row.indexOf('\t');
    const mode = row.slice(0, 6);
    const path = row.slice(delimiter + 1);
    if (delimiter < 0) throw new Error('Git returned malformed tree output.');
    if (mode !== '100644' && mode !== '100755') continue;
    if (extensions.length && !extensions.some(ext => path.endsWith(ext))) continue;
    if (folders.length && !folders.some(folder => path.startsWith(`${folder}/`))) continue;
    files.push(repoPath(path));
    if (files.length > maxPaths) throw new Error(`Inventory exceeds ${maxPaths} files. Narrow it with --ext or --under.`);
  }
  if (!files.length) throw new Error('No tracked regular files match the inventory filters.');
  return { version: 1, kind: 'scan-coverage-inventory', commit, files: files.sort() };
}
