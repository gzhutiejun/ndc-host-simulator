const path = require('node:path');
const fs = require('node:fs');

const { createTransport } = require('./src/transport');
const { createDecoder, encodeLength, encodeText } = require('./src/framing');
const { parse } = require('./src/ndc/parser');
const { createSession } = require('./src/session');
const { createEngine } = require('./src/engine');
const { parseLibrary } = require('./src/message-library');
const { createLogger } = require('./src/logging');
const { createUiServer } = require('./src/ui-server');
const { buildTerminalCommand } = require('./src/push');
const goInService = require('./src/handlers/goInService');
const makeWithdrawal = require('./src/handlers/withdrawal');
const makeBalance = require('./src/handlers/balance');
const makeGeneric = require('./src/handlers/generic');

// 报文库文件是 NCR 给的第三方文件（640KB，不入库，每台机器路径可能不同）。不配路径时
// 直接返回空数组——引擎的行为跟压根没有 library 参数时完全一样。配了路径但读不到/解析
// 出问题时也不抛错、不让模拟器起不来，只记一条日志降级到空库：手动覆盖里的 { key } 用法会
// 不可用，但规则引擎（默认路径）不受影响。
function loadMessageLibrary(libraryPath) {
  if (!libraryPath) return [];
  try {
    const buf = fs.readFileSync(libraryPath);
    const records = parseLibrary(buf);
    const skippedNote = records.skipped ? `，跳过 ${records.skipped} 条坏记录` : '';
    console.log(`Message library loaded: ${records.length} entries from ${libraryPath}${skippedNote}`);
    return records;
  } catch (err) {
    console.error(`Message library unavailable (${libraryPath}): ${err.message} — falling back to rule engine only`);
    return [];
  }
}

function createApp(config) {
  const captureDir = config.captureDir || path.join(__dirname, 'captures');
  const responseDelayMs = config.responseDelayMs || 0;
  const handlers = {
    goInService,
    withdrawal: makeWithdrawal(config.withdrawal || {}),
    balance: makeBalance(config.balance || {}),
    familyD: makeGeneric(config.familyD || { nextState: '698' }),
    familyI: makeGeneric(config.familyI || { nextState: '175' }),
    generic: makeGeneric(config.generic || {}),
  };
  const library = loadMessageLibrary(config.messageLibrary);
  const engine = createEngine({ rules: config.rules || [], handlers, library });
  const pushOnConnect = Array.isArray(config.pushOnConnect) ? config.pushOnConnect : [];
  const logger = createLogger({ dir: captureDir });

  // Task 3 的 HTTP 控制台：只有配了 config.uiPort（非 0/false）才会真的建这个对象——
  // 不配时 `ui` 恒为 null，下面所有 `if (ui)` 分支都不会跑，也就永远不会调用
  // http.createServer，满足"uiPort 未配置时完全不启动 HTTP"这一条硬约束。
  // activeSockets 是 POST /api/push（"立刻下发一条终端命令，不等 ATM 请求"）需要的：
  // 它得知道现在有哪些连接可以写。
  const activeSockets = new Set();
  function pushToActiveSockets(spec) {
    const bytes = encodeText(buildTerminalCommand(spec));
    let sent = 0;
    for (const socket of activeSockets) {
      if (socket.destroyed) continue;
      logger.record('SEND', bytes, { type: 'TerminalCommand', rule: 'ui:push' });
      if (ui) ui.publish('SEND', bytes, { type: 'TerminalCommand', rule: 'ui:push' });
      socket.write(encodeLength(bytes));
      sent += 1;
    }
    return { sent };
  }
  const ui = config.uiPort ? createUiServer({ engine, library, push: pushToActiveSockets }) : null;

  const server = createTransport(config, (socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`Client connected from ${peer}`);
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
    const session = createSession();
    const decoder = createDecoder();

    // 主动下发：模拟主机索取状态的终端命令（手册 Table 10-1）。
    // 默认 pushOnConnect 为空，行为与不配置时完全一致。
    for (const spec of pushOnConnect) {
      setTimeout(() => {
        if (socket.destroyed) return;
        try {
          const bytes = encodeText(buildTerminalCommand(spec));
          logger.record('SEND', bytes, { type: 'TerminalCommand', rule: 'pushOnConnect' });
          if (ui) ui.publish('SEND', bytes, { type: 'TerminalCommand', rule: 'pushOnConnect' });
          socket.write(encodeLength(bytes));
        } catch (err) {
          console.error(`pushOnConnect error (entry skipped): ${err.message}`);
        }
      }, spec.delayMs || 0);
    }

    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        console.error(`Framing error from ${peer}: ${err.message}`);
        return;
      }
      for (const payload of frames) {
        try {
          const parsed = parse(payload);
          session.remember(parsed);
          let result = { payload: null, rule: null };
          try {
            result = engine.respond(parsed, session);
          } catch (err) {
            console.error(`Engine error: ${err.message}`);
          }
          logger.record('RECV', payload, {
            type: parsed.type,
            rule: result.rule == null ? 'UNMATCHED' : result.rule,
          });
          if (ui) ui.publish('RECV', payload, { type: parsed.type, rule: result.rule });
          if (result.rule == null) {
            // 真正未识别：完整 hex 已录，明确告警，不静默丢弃
            console.error(`No rule matched for ${parsed.type} — see capture for full hex`);
            continue;
          }
          if (result.payload == null) {
            // 匹配到 noReply 规则（如 ReadyB 心跳/设备状态）：正常无应答，不告警
            continue;
          }
          const bytes = encodeText(result.payload);
          logger.record('SEND', bytes, { type: parsed.type, rule: result.rule });
          if (ui) ui.publish('SEND', bytes, { type: parsed.type, rule: result.rule });
          const out = encodeLength(bytes);
          setTimeout(() => {
            if (!socket.destroyed) socket.write(out);
          }, responseDelayMs);
        } catch (err) {
          console.error(`Frame processing error (frame skipped): ${err.message}`);
        }
      }
    });

    socket.on('end', () => console.log(`Client disconnected: ${peer}`));
    socket.on('error', (err) => console.error(`Socket error ${peer}: ${err.message}`));
  });

  server.on('error', (err) => console.error(`Server error: ${err.message}`));

  return {
    server,
    // Task 3 的 HTTP 控制台（POST /api/next）就是靠这个 engine 引用调用
    // engine.setNextResponse(...)；这里不启动任何 HTTP，只是把已经存在的引擎实例
    // 露出去，本身不改变 NDC 端口上的任何行为。
    engine,
    // 未配 config.uiPort 时恒为 null——测试用这个钉住"不配置就不启动 HTTP"。
    ui,
    start(port) {
      server.listen(port, () => console.log(`NDC host simulator listening on port ${port}`));
      if (ui) {
        ui.listen(config.uiPort, () => console.log(`UI console listening on port ${config.uiPort}`));
      }
      return server;
    },
  };
}

if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const port = config.port || 2000;
  const mode = config.enableTLS ? 'TLS 1.2' : 'TCP';
  console.log(`Starting ${mode} server on port ${port}...`);
  createApp(config).start(port);
}

module.exports = { createApp };
