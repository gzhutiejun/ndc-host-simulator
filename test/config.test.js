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

test('规则集：上电报文触发 go-in-service，且排在 unsolicited 兜底之前', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const names = cfg.rules.map((r) => r.name);
  assert.ok(names.includes('powerup-go-in-service'), '缺 powerup-go-in-service 规则');
  assert.ok(
    names.indexOf('powerup-go-in-service') < names.indexOf('unsolicited-status-no-reply'),
    'powerup 规则必须排在 unsolicited 兜底之前，否则永远匹配不到',
  );
});

test('规则集：Ready 9 不再触发 go-in-service（会与 ATM 打成无限循环）', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const ready9 = cfg.rules.filter(
    (r) => r.match && r.match.messageClass === '2'
      && r.match.field && r.match.field.startsWith === '9',
  );
  assert.strictEqual(ready9.length, 1, '应恰好有一条匹配 Ready 9 的规则');
  assert.strictEqual(ready9[0].handler, undefined, 'Ready 9 不应挂 handler');
  assert.strictEqual(ready9[0].noReply, true, 'Ready 9 应为 noReply');
});
