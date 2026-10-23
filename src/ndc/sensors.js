// 传感器状态解码。
//   P 报文（12<FS>luno<FS><FS>P…）：类型 2 = 模式（P20 / P21 / P211），类型 1 / 3 / 5 / 6 之后跟 12 个 0/1（字节 2-13）。
//   K 报文（74 的应答 22…F 的状态信息）：KA 段 5 位，B 段 13 位（7 位 + 硬币机 1 + hopper 4 + 保留 1），可选 C 段原文。

const KINDS = { 1: 'ti', 3: 'alarm', 5: 'full', 6: 'flexible' };

function parseSensorsStatus(e1e2) {
  if (typeof e1e2 !== 'string' || e1e2[0] !== 'P') {
    return { kind: 'unknown', errors: ['not a P status'] };
  }
  const type = e1e2[1];
  if (type === '2') {
    return { kind: 'mode', entered: e1e2[2] === '1', aer: e1e2[3] === '1', errors: [] };
  }
  const kind = KINDS[type];
  if (!kind) return { kind: 'unknown', errors: [`unknown sensor status type "${type}"`] };
  const bits = e1e2.slice(2, 14);
  if (!/^[01]{12}$/.test(bits)) {
    return { kind, errors: [`bytes 2-13 must be 12 chars of 0/1, got "${bits}"`] };
  }
  const b = (i) => bits[i] === '1';
  return {
    kind,
    supervisor: b(0),
    vibrationHeat: b(1),
    door: b(2),
    silentSignal: b(3),
    enclosure: b(4),
    depositBin: b(5),
    cardBin: b(6),
    rejectBin: b(7),
    cassettes: [b(8), b(9), b(10), b(11)],
    extra: e1e2.slice(14),
    errors: [],
  };
}

function parseTamperSensorStatus(fields) {
  const errors = [];
  const list = fields || [];
  const af = list.find((f) => f[0] === 'K');
  const bf = list.find((f) => f[0] === 'B');
  const cf = list.find((f) => f[0] === 'C');
  const out = { a: undefined, b: undefined, errors };
  if (!af || !/^KA[01]{5}$/.test(af)) {
    errors.push('K segment must be "KA" + 5 chars of 0/1');
  } else {
    const x = (i) => af[2 + i] === '1';
    out.a = { supervisor: x(0), vibrationHeat: x(1), door: x(2), silentSignal: x(3), enclosure: x(4) };
  }
  if (bf === undefined) {
    // B 段可选：开关关时 74 回 KA00000（无 B 段）。
  } else if (!/^B[01]{13}$/.test(bf)) {
    errors.push('B segment must be "B" + 13 chars of 0/1');
  } else {
    const x = (i) => bf[1 + i] === '1';
    out.b = {
      depositBin: x(0), cardBin: x(1), rejectBin: x(2),
      cassettes: [x(3), x(4), x(5), x(6)],
      coinDispenser: x(7),
      hoppers: [x(8), x(9), x(10), x(11)],
      reserved: x(12),
    };
  }
  if (cf !== undefined) out.c = cf;
  return out;
}

module.exports = { parseSensorsStatus, parseTamperSensorStatus };
