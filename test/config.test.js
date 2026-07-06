const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

test('config.json: familyD/familyI blocks carry the observed next-states (698/175)', () => {
  assert.strictEqual(cfg.familyD.nextState, '698');
  assert.strictEqual(cfg.familyI.nextState, '175');
});

test('config.json: d/i family rules precede the generic-fallback catch-all and route correctly', () => {
  const names = cfg.rules.map((r) => r.name);
  const d = names.indexOf('d-family-reply');
  const i = names.indexOf('i-family-reply');
  const g = names.indexOf('generic-fallback');
  assert.ok(d !== -1 && i !== -1, 'both family rules present');
  assert.ok(g !== -1, 'generic-fallback present');
  assert.ok(d < g && i < g, 'family rules must come before generic-fallback');
  assert.strictEqual(cfg.rules[d].match.field.startsWith, 'D');
  assert.strictEqual(cfg.rules[d].handler, 'familyD');
  assert.strictEqual(cfg.rules[i].match.field.startsWith, 'I');
  assert.strictEqual(cfg.rules[i].handler, 'familyI');
});
