const test = require('node:test');
const assert = require('node:assert');
const { buildTr31, unwrapTr31, cmac } = require('../src/ndc/tr31');

const KBPK = '33'.repeat(16);
const PAD = 'A5'.repeat(8);
const E_KEY = '0123456789ABCDEFFEDCBA9876543210';
const F_KEY = '89ABCDEF01234567FEDCBA9876543210';
const L_KEY = 'FEDCBA987654321089ABCDEF01234567';
const E_BLOCK = 'B0080P0TE00N00003626243F257F45D884418AF38EC0C630B31D14E03D637901354AAEC3D548FA42';
const F_BLOCK = 'B0080M3TG00N00004C94C822B6EA2923E906F0436A67AD0EFC266F16008EBF0FA16BDB876318A07E';
const L_BLOCK = 'B0080M3TC00N00005781ED53D4CD18F3EFDC262CFB67A179C3732325FEAFF26B769FB37153B5C5D0';

test('CMAC：NIST SP 800-38B 的 2-key 样例', () => {
  const k = Buffer.from('4CF15134A2850DD58A3D10BA80570D38', 'hex');
  assert.strictEqual(cmac(k, Buffer.alloc(0)).toString('hex'), 'bd2ebf9a3ba00361');
  assert.strictEqual(cmac(k, Buffer.from('6BC1BEE22E409F96', 'hex')).toString('hex'), '4ff2ab813c53ce83');
});

test('unwrapTr31：外部已知值（A / B / C）解出原密钥', () => {
  const cases = [
    ['89E88CF7931444F334BD7547FC3F380C', 'F039121BEC83D26B169BDCD5B22AAF8F', 'A0072P0TE00E0000F5161ED902807AF26F1D62263644BD24192FDB3193C730301CEE8701'],
    ['DD7515F2BFC17F85CE48F3CA25CB21F6', '3F419E1CB7079442AA37474C2EFBF8B8', 'B0080P0TE00E000094B420079CC80BA3461F86FE26EFC4A3B8E4FA4C5F5341176EED7B727B8A248E'],
    ['AAAAAAAAAAAAAAAABBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCDDDDDDDDDDDDDDDD', 'C0088M3TC00E00009BC6306FC31891BF87B3148463627B1D68C603D9FAB9074E4A0D2E78D40B29905A826F5C'],
    ['89E88CF7931444F334BD7547FC3F380C', 'F039121BEC83D26B169BDCD5B22AAF8F', 'A0088P0TE00E00007DD4DD9566DC0E2F956DCAC0FDE9153159539373E9D82D3CD4AFD305A7EF1BA67FE03712'],
  ];
  for (const [kbpk, key, block] of cases) assert.strictEqual(unwrapTr31(kbpk, block), key, block.slice(0, 16));
});

test('unwrapTr31：MAC 末位被改则抛错', () => {
  const bad = E_BLOCK.slice(0, -1) + (E_BLOCK.endsWith('2') ? '3' : '2');
  assert.throws(() => unwrapTr31(KBPK, bad), /MAC/);
});

test('buildTr31 往返（A / B / C）', () => {
  for (const version of ['A', 'B', 'C']) {
    const { block } = buildTr31({ kbpk: KBPK, key: E_KEY, version });
    assert.strictEqual(block[0], version);
    assert.strictEqual(unwrapTr31(KBPK, block), E_KEY, version);
  }
});

test('buildTr31 随机填充：两次生成的块不同但都能解开', () => {
  const a = buildTr31({ kbpk: KBPK, key: E_KEY });
  const b = buildTr31({ kbpk: KBPK, key: E_KEY });
  assert.notStrictEqual(a.block, b.block);
  assert.strictEqual(unwrapTr31(KBPK, b.block), E_KEY);
});

test('VM 向量：e / f / l 的块与 KCV', () => {
  const e = buildTr31({ kbpk: KBPK, key: E_KEY, usage: 'P0', mode: 'E', pad: PAD });
  assert.deepStrictEqual(e, { block: E_BLOCK, kcv: '08D7B4' });
  const f = buildTr31({ kbpk: KBPK, key: F_KEY, usage: 'M3', mode: 'G', pad: PAD });
  assert.deepStrictEqual(f, { block: F_BLOCK, kcv: 'AD7614' });
  const l = buildTr31({ kbpk: KBPK, key: L_KEY, usage: 'M3', mode: 'C', pad: PAD });
  assert.deepStrictEqual(l, { block: L_BLOCK, kcv: '2B9517' });
});

test('小写 kbpk / key 与大写逐字节相同（block 与 kcv）', () => {
  const kbpk = 'dd7515f2bfc17f85ce48f3ca25cb21f6';
  const key = 'abcdef0123456789fedcba9876543210';
  for (const version of ['A', 'B', 'C']) {
    const up = buildTr31({ kbpk: kbpk.toUpperCase(), key: key.toUpperCase(), version, pad: PAD });
    const lo = buildTr31({ kbpk, key, version, pad: PAD });
    assert.deepStrictEqual(lo, up, version);
    assert.strictEqual(lo.block, lo.block.toUpperCase());
  }
});

test('buildTr31 拒绝坏输入', () => {
  assert.throws(() => buildTr31({ kbpk: KBPK, key: 'AB' }), /key/);
  assert.throws(() => buildTr31({ kbpk: 'zz', key: E_KEY }), /kbpk/);
  assert.throws(() => buildTr31({ kbpk: KBPK, key: E_KEY, version: 'D' }), /version/);
  assert.throws(() => buildTr31({ kbpk: KBPK, key: E_KEY, pad: 'A5' }), /pad/);
});
