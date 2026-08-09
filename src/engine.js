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
  // 库 key -> payload 的索引。曾经懒建（大多数调用根本不传 library），但规则里的
  // libraryKey 需要在构造期就校验（见下），所以改成立即建——library 通常是空数组或
  // 已经解析好的 ~1000 条记录，建一次 Map 的开销可以忽略。
  const libraryIndex = new Map();
  for (const entry of library) {
    if (entry && typeof entry.key === 'string') libraryIndex.set(entry.key, entry.payload);
  }
  function resolveKey(key) {
    return libraryIndex.get(key);
  }

  // 规则里的 libraryKey 在这里、构造 engine 的时候就校验，而不是等到respond()第一次
  // 用到那条规则才发现库里没有这个 key。理由：respond() 是在 ATM 真连上来发一条特定
  // 报文时才会走到某条具体规则——如果校验放在那里，一条"字典打错了"的配置可以在收银台
  // 静默运行几个月，直到测试脚本恰好发一笔取款才暴露成"这台主机模拟器没回应"，排查起来
  // 比"启动时直接崩"贵得多。库为空（没配 messageLibrary，或库文件解析失败降级成空数组）
  // 时同样会在这里失败：查不到就是查不到，跟"库非空但没这个 key"是同一种错误，没有理由
  // 网开一面——"没配库"不是"这条规则不需要库"的许可证，规则既然点名要 libraryKey，就必须
  // 有库能满足它。
  for (const rule of rules) {
    if (rule.libraryKey != null && !libraryIndex.has(rule.libraryKey)) {
      const reason = library.length === 0
        ? '未加载任何报文库（未配置 messageLibrary，或加载失败已降级为空库）'
        : `已加载的报文库共 ${library.length} 条，其中没有这个 key`;
      throw new Error(`Rule "${rule.name}" references unknown library key "${rule.libraryKey}" — ${reason}`);
    }
    // libraryKeyFromField 的键要等报文进来才知道，没法逐个校验存在性；但「库是空的」
    // 这一种必错的情形可以在构造期就抓住——理由与上面 libraryKey 的校验相同。
    if (rule.libraryKeyFromField != null && libraryIndex.size === 0) {
      throw new Error(
        `Rule "${rule.name}" uses libraryKeyFromField but no message library is loaded ` +
          '(messageLibrary not configured, or the library failed to load and degraded to empty)',
      );
    }
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
        if (rule.libraryKeyFromField != null) {
          // 用入站报文里的操作码直接查库。库键是定长 8 字节，报文段末尾的空格
          // 容易丢，所以补齐后再查。
          const raw = (parsed.fields || [])[rule.libraryKeyFromField.index] || '';
          const key = raw.padEnd(8, ' ');
          if (libraryIndex.has(key)) {
            return { payload: libraryIndex.get(key), rule: `${rule.name}:${key}` };
          }
          continue; // 库里没有这个操作码：交给后面的规则（家族 handler / generic 兜底）
        }
        if (rule.libraryKey != null) {
          // 存在性已经在构造期校验过（见上），这里直接取，取到的必是真实报文库
          // 里的原始报文——不套 applyTemplate，跟 setNextResponse({ key }) 的
          // 覆盖通道行为一致：库载荷已经是完整、真实的 NDC 报文文本。
          return { payload: libraryIndex.get(rule.libraryKey), rule: rule.name };
        }
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
        throw new Error(`Rule "${rule.name}" matched but defines no template, handler, libraryKey, or noReply`);
      }
      return { payload: null, rule: lastRule };
    },
  };
}

module.exports = { applyTemplate, matches, createEngine };
