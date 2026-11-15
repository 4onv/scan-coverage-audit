#!/usr/bin/env node
import { parseArgs } from 'node:util';
import info from '../package.json' with { type: 'json' };
import { checkInventory } from '../src/coverage.js';
import { demo } from '../src/demo.js';
import { inventory, jsonFile } from '../src/inventory.js';

const help = `Usage:
  scan-coverage-audit plan [-C repo] [--ref ref] [--ext .js ...] [--under src ...]
  scan-coverage-audit check inventory.json [--eslint report.json ...]
    [--semgrep report.json ...] [--receipt report.json ...]
    [--report-root /absolute/checkout] [--fail-extra] [--json]
  scan-coverage-audit demo [--json]

Plan prints a Git inventory as JSON. Check exits 0 for full coverage, 1 for
coverage gaps or scan errors, and 2 for usage or invalid input.`;

const list = { type: 'string', multiple: true, default: [] };
const json = { type: 'boolean' };
const options = {
  plan: { repo: { type: 'string', short: 'C', default: '.' }, ref: { type: 'string' }, ext: list, under: list },
  check: { eslint: list, semgrep: list, receipt: list, 'report-root': { type: 'string' }, 'fail-extra': json, json },
  demo: { json },
};

function quote(value) {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function render(report, asJson) {
  if (asJson) return JSON.stringify(report, null, 2);
  const { counts } = report;
  const lines = [
    `${report.ok ? 'PASS' : 'FAIL'}  ${counts.scanned}/${counts.expected} expected files scanned`,
    `      ${counts.missing} missing · ${counts.skipped} skipped · ${counts.error} errored · ${counts.globalErrors} scan-wide errors`,
  ];
  if (report.synthetic) lines.unshift('Synthetic demo · scanner findings: 0', '');
  else lines.push(`      Inventory commit ${report.commit}`);
  for (const gap of report.gaps.slice(0, 20)) {
    lines.push(`  ${gap.status.toUpperCase().padEnd(7)} ${quote(gap.path)}`);
  }
  if (report.gaps.length > 20) lines.push(`  … ${report.gaps.length - 20} more gaps. Use --json for all paths.`);
  if (counts.extra || counts.outsideRoot) {
    lines.push(`      ${counts.extra} extra paths · ${counts.outsideRoot} records outside the report root`);
  }
  return lines.join('\n');
}

function main([command, ...args]) {
  if (!command || command === '--help' || command === '-h') {
    console.log(help);
    return 0;
  }
  if (command === '--version') {
    console.log(info.version);
    return 0;
  }
  if (!Object.hasOwn(options, command)) throw new Error('Expected plan, check, or demo. See --help.');
  const { values, positionals } = parseArgs({
    args, options: { ...options[command], help: { type: 'boolean', short: 'h' } },
    allowPositionals: command === 'check',
  });
  if (values.help) {
    console.log(help);
    return 0;
  }
  if (command === 'demo') {
    console.log(render(demo(), values.json));
    return 0;
  }
  if (command === 'plan') {
    console.log(JSON.stringify(inventory(values.repo, {
      ref: values.ref, extensions: values.ext, under: values.under,
    }), null, 2));
    return 0;
  }
  if (positionals.length !== 1) throw new Error('Provide exactly one inventory file.');
  const inputs = ['eslint', 'semgrep', 'receipt'].flatMap(format =>
    values[format].map(path => ({ format, path })));
  if (!inputs.length || inputs.length > 64) throw new Error('Provide between 1 and 64 scanner reports.');
  const plan = jsonFile(positionals[0], 'Inventory');
  function* readReports() {
    for (const [index, { format, path }] of inputs.entries()) {
      yield { format, data: jsonFile(path, `Report ${index + 1}`) };
    }
  }
  const report = checkInventory(plan, readReports(), {
    reportRoot: values['report-root'], failExtra: values['fail-extra'],
  });
  console.log(render(report, values.json));
  return report.ok ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`scan-coverage-audit: ${quote(error.message).slice(1, -1)}`);
  process.exitCode = 2;
}
