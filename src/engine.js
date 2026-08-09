const constants = require('./constants');
const { FS, GS, SO, SI } = constants;

function applyTemplate(template, ctx) {
  return template
    .replace(/<FS>/g, FS)
    .replace(/<GS>/g, GS)
    .replace(/<SO>/g, SO)
    .replace(/<SI>/g, SI)
    .replace(/<LUNO>/g, ctx.luno != null ? ctx.luno : '')
    .replace(/<TVN>/g, ctx.tvn != null ? ctx.tvn : '');
}

function matches(match, parsed) {
  if (!match) return true;
  if (match.messageClass != null && parsed.messageClass !== match.messageClass) return false;
  if (match.subClass != null && parsed.subClass !== match.subClass) return false;
  if (match.type != null && parsed.type !== match.type) return false;
  if (match.field != null) {
    const value = parsed.fields[match.field.index];
    if (value == null) return false;
    if (match.field.equals != null && value !== match.field.equals) return false;
    if (match.field.startsWith != null && !value.startsWith(match.field.startsWith)) return false;
  }
  return true;
}

function createEngine({ rules = [], handlers = {}, now = () => new Date(), library = [] } = {}) {
  // 库 key -> payload 的索引，懒建（大多数调用根本不传 library，不必白建一次）。
  let libraryIndex = null;
  function resolveKey(key) {
    if (libraryIndex === null) {
      libraryIndex = new Map();
      for (const entry of library) {
        if (entry && typeof entry.key === 'string') libraryIndex.set(entry.key, entry.payload);
      }
    }
    return libraryIndex.get(key);
  }

  // 一次性覆盖：respond() 用一次就清（见下）。不设置时这个变量恒为 null，
  // respond() 直接落进原有规则循环，逐字节不变。
  let nextResponse = null;

  return {
    // override 三选一：
    //   { key: '<库里的键>' }  —— 从 Task 1 的 parseLibrary 结果里查 payload；查不到直接抛，
    //                            让调用方（控制台）在"设置"这一刻就发现坏 key，而不是拖到
    //                            下一条报文进来时才失败。
    //   { payload: '<原始报文文本>' } —— 原样使用，不套 applyTemplate。
    //   { noReply: true } —— 下一条入站报文不应答，用来测 ATM 自己的主机应答超时。
    //   null/undefined —— 撤销已设置但还没用掉的覆盖（不消耗一次使用）。
    setNextResponse(override) {
      if (override == null) {
        nextResponse = null;
        return;
      }
      if (override.noReply === true) {
        nextResponse = { kind: 'noReply' };
        return;
      }
      if (typeof override.payload === 'string') {
        nextResponse = { kind: 'payload', payload: override.payload, label: 'override:payload' };
        return;
      }
      if (typeof override.key === 'string') {
        const payload = resolveKey(override.key);
        if (payload === undefined) {
          throw new Error(`setNextResponse: unknown library key "${override.key}"`);
        }
        nextResponse = { kind: 'payload', payload, label: `override:key:${override.key}` };
        return;
      }
      throw new Error('setNextResponse: override must be { key }, { payload }, { noReply: true }, or null/undefined to clear');
    },
    respond(parsed, session) {
      // 覆盖检查放在规则循环之前、任何匹配逻辑之前：一旦设置了覆盖，它必须赢过规则
      // （包括 noReply 规则）。没设置时（nextResponse === null，默认状态）这个 if 直接
      // 跳过，下面的规则循环是改动前的原样代码，行为逐字节不变。
      if (nextResponse !== null) {
        const override = nextResponse;
        nextResponse = null; // 用掉即清：不管这次匹配与否，覆盖只吃一条入站报文
        if (override.kind === 'noReply') return { payload: null, rule: 'override:noReply' };
        return { payload: override.payload, rule: override.label };
      }
      const ctx = {
        luno: (session && session.luno) || parsed.luno || '',
        tvn: session ? String(session.tvn) : '0',
      };
      let lastRule = null;
      for (const rule of rules) {
        if (!matches(rule.match, parsed)) continue;
        lastRule = rule.name;
        if (rule.noReply === true) return { payload: null, rule: rule.name };
        if (rule.handler != null) {
          const fn = handlers[rule.handler];
          if (typeof fn !== 'function') {
            throw new Error(`Rule "${rule.name}" references unknown handler "${rule.handler}"`);
          }
          const payload = fn(parsed, session, { applyTemplate, ctx, constants, now });
          if (payload != null) return { payload, rule: rule.name };
          continue; // handler 返回 null：本规则不适用，试下一条匹配规则
        }
        if (rule.template != null) return { payload: applyTemplate(rule.template, ctx), rule: rule.name };
        throw new Error(`Rule "${rule.name}" matched but defines no template, handler, or noReply`);
      }
      return { payload: null, rule: lastRule };
    },
  };
}

module.exports = { applyTemplate, matches, createEngine };
