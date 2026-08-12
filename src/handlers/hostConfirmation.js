const { buildInteractiveResponse } = require('../ndc/interactiveResponse');
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractRequest } = require('../ndc/transactionRequest');

/** Transaction Request 里 Buffer B 的段下标（字段 m）。 */
const BUFFER_B_INDEX = 10;

/**
 * 内置场景。`screenData` 里的标签就是 ATM 侧解析器认的那几个；`accept`/`decline` 是
 * ATM 会放进 Buffer B 的字母。
 *
 * 字母表出处：Atleos Activate 的
 * `ChnApp/Cnsmr/CnsmrAppAE/Source/Config/Customiser/RequestConfigurationTool.xml`
 * 的 `BufferBConfiguration`（手续费 589-712，汇率 1467-1593）。
 */
const SCENARIOS = {
  surcharge: {
    activeKeys: 'AB',
    screenData: 'SURCHARGE;A SURCHARGE OF $2.00 APPLIES;Fee=$2.00;PRESS A TO ACCEPT B TO CANCEL;',
    accept: ['A'],
    decline: ['B'],
  },
  overdraft: {
    activeKeys: 'CD',
    screenData: 'OVERDRAFT FEE;Fee=$35.00;PRESS C TO ACCEPT D TO CANCEL;',
    accept: ['C'],
    decline: ['D'],
  },
  fee0: {
    activeKeys: 'AB',
    screenData: 'FEE0;Fee=$1.50;PRESS A TO ACCEPT B TO CANCEL;',
    accept: ['A'],
    decline: ['B'],
  },
  // FX：外币取款，主机报本币金额让持卡人接受或放弃（参考币种只有本币一个）。
  fx: {
    activeKeys: 'CD',
    screenData: [
      'CONDITIONAL=1805',
      'EXCHANGETYPE=FX',
      'WITHDRAW=USD 100.00',
      'EXCHANGEL=ZAR 18.5000',
      'TOTALL=ZAR 1850.00',
      'TOTALF=USD 100.00',
      '',
    ].join(';'),
    accept: ['C'],
    decline: ['D'],
  },
  // DCC：让持卡人在两种币种之间选，三个选项（外币 D / 本币 F / 放弃 E）。
  dcc: {
    activeKeys: 'DEF',
    screenData: [
      'CONDITIONAL=1800',
      'EXCHANGETYPE=DCC',
      'WITHDRAW=USD 100.00',
      'EXCHANGEL=ZAR 18.5000',
      'EXCHANGEF=USD 0.0540',
      'TOTALL=ZAR 1850.00',
      'TOTALF=USD 100.00',
      'EXCHANGEFEE=XXX 3.5',
      '',
    ].join(';'),
    accept: ['D', 'F'],
    decline: ['E'],
  },
};

/**
 * 「先确认再记账」的主机侧。
 *
 * 三态，靠入站请求的 Buffer B 区分：
 *
 * 1. **第一条请求**（Buffer B 不是本场景的应答字母）→ 回一条 Interactive Transaction
 *    Response，让 ATM 弹屏。注意判据是"字母在不在本场景的选项里"，不是"Buffer B 是不是
 *    空的"——转账的 Buffer B 本来就放着目标账号。
 * 2. **持卡人接受后的重发**（Buffer B 是接受字母）→ 返回 `null`，让引擎把这条请求交给
 *    后面的规则（报文库/家族 handler）去答一条真正的 Transaction Reply。这正是真实主机的
 *    行为：确认之后这一笔才走正常授权。
 * 3. **持卡人拒绝后的重发**（Buffer B 是拒绝字母）→ 回一条拒绝的 Transaction Reply。
 *
 * 每笔只问一次：`session` 上记下已经问过，避免第 2 步落回本 handler 时又问一遍
 * （接受字母判据已经挡住了，这个标记是第二道防线，也让"每连接问几次"可观测）。
 *
 * 默认 **关闭**（`enabled` 不为 true 时恒返回 null，逐字节等价于没有这条规则）——
 * 开着它会让每一笔交易都多一轮确认，不该是模拟器的出厂行为。
 */
module.exports = function makeHostConfirmation(cfg = {}) {
  const enabled = cfg.enabled === true;
  const scenarioName = cfg.scenario != null ? cfg.scenario : 'surcharge';
  const builtin = SCENARIOS[scenarioName];
  if (enabled && !builtin && cfg.screenData == null) {
    throw new Error(
      `hostConfirmation: unknown scenario "${scenarioName}" `
        + `(known: ${Object.keys(SCENARIOS).join(', ')}); or supply screenData/accept/decline explicitly`,
    );
  }
  const base = builtin || {};
  // 自定义场景：显式给的 screenData/accept/decline 覆盖内置的那一套。
  const screenData = cfg.screenData != null ? cfg.screenData : base.screenData;
  const activeKeys = cfg.activeKeys != null ? cfg.activeKeys : base.activeKeys;
  const accept = cfg.accept != null ? cfg.accept : base.accept || [];
  const decline = cfg.decline != null ? cfg.decline : base.decline || [];
  const displayFlag = cfg.displayFlag != null ? cfg.displayFlag : '1';
  const screenTimer = cfg.screenTimer != null ? cfg.screenTimer : 30;
  const declineNextState = cfg.declineNextState != null ? cfg.declineNextState : '048';
  const declinePrinter = cfg.declinePrinter != null
    ? cfg.declinePrinter
    : '<GS>1  TRANSACTION CANCELLED<LF>  FEE DECLINED<LF><FF>';

  return function hostConfirmation(parsed, session, helpers) {
    if (!enabled) return null;

    const bufferB = (parsed.fields || [])[BUFFER_B_INDEX] || '';
    const req = extractRequest(parsed);

    if (accept.includes(bufferB)) {
      // 持卡人接受了。交给后面的规则去答真正的交易应答。
      session.confirmationSettled = true;
      return null;
    }

    if (decline.includes(bufferB)) {
      session.confirmationSettled = true;
      const printer = req.mcn + '0' + '1'
        + (helpers && helpers.applyTemplate ? helpers.applyTemplate(declinePrinter, {}) : declinePrinter);
      return buildTransactionReply({
        luno: req.luno,
        nextState: declineNextState,
        fieldG: '',
        screen: '',
        printer,
      });
    }

    if (session.confirmationAsked === true) {
      // 已经问过、Buffer B 却既不是接受也不是拒绝：ATM 没有按约定回话（或字母表对不上）。
      // 不再重复追问——那会和 ATM 的轮数上限对撞，变成一个来回刷屏的死循环。
      return null;
    }

    session.confirmationAsked = true;
    return buildInteractiveResponse({
      luno: req.luno,
      displayFlag,
      activeKeys,
      screenTimer,
      screenData,
    });
  };
};

module.exports.SCENARIOS = SCENARIOS;
