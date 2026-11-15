import { checkInventory } from './coverage.js';

export function demo() {
  const plan = {
    version: 1,
    kind: 'scan-coverage-inventory',
    commit: '0'.repeat(40),
    files: ['src/checkout.js', 'src/coupons.js', 'src/returns.js', 'src/tax.js'],
  };
  const report = {
    results: [],
    paths: {
      scanned: ['src/checkout.js', 'src/tax.js'],
      skipped: [{ path: 'src/coupons.js', reason: 'Synthetic size cap' }],
    },
    errors: [{ path: 'src/tax.js', message: 'Synthetic parse failure' }],
  };
  return { ...checkInventory(plan, [{ format: 'semgrep', data: report }]), synthetic: true };
}
