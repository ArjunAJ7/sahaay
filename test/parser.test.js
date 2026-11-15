const test = require('node:test');
const assert = require('node:assert');
const { parseQuickAdd } = require('../src/parser');

test('extracts explicit name, dosage, frequency, instructions', () => {
  const r = parseQuickAdd('Dolo 650mg twice daily after food');
  assert.strictEqual(r.name, 'Dolo');
  assert.strictEqual(r.dosage, '650mg');
  assert.strictEqual(r.dosesPerDay, 2);
  assert.strictEqual(r.instructions, 'after food');
});

test('never invents a frequency', () => {
  const r = parseQuickAdd('Vitamin D3 1000 IU');
  assert.strictEqual(r.dosesPerDay, null);
  assert.ok(r.warnings.includes('frequency_not_found'));
});

test('never invents times or dosage', () => {
  const r = parseQuickAdd('Metformin once daily');
  assert.strictEqual(r.dosesPerDay, 1);
  assert.strictEqual(r.dosage, null);
  assert.strictEqual(r.name, 'Metformin');
});

test('empty input yields nulls, not guesses', () => {
  const r = parseQuickAdd('');
  assert.deepStrictEqual([r.name, r.dosage, r.dosesPerDay], [null, null, null]);
});

test('three times a day variant', () => {
  const r = parseQuickAdd('Amoxicillin 500mg three times a day');
  assert.strictEqual(r.dosesPerDay, 3);
  assert.strictEqual(r.dosage, '500mg');
});
