const path = require('node:path');
const fs = require('node:fs');

const { createTransport } = require('./src/transport');
const { createDecoder, encodeLength, encodeText } = require('./src/framing');
const { parse } = require('./src/ndc/parser');
const { createSession } = require('./src/session');
const { createEngine } = require('./src/engine');
const { createLogger } = require('./src/logging');
const goInService = require('./src/handlers/goInService');
const makeWithdrawal = require('./src/handlers/withdrawal');

function createApp(config) {
  const captureDir = config.captureDir || path.join(__dirname, 'captures');
  const responseDelayMs = config.responseDelayMs || 0;
  const handlers = {
    goInService,
    withdrawal: makeWithdrawal(config.withdrawal || {}),
  };
  const engine = createEngine({ rules: config.rules || [], handlers });
  const logger = createLogger({ dir: captureDir });

  const server = createTransport(config, (socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`Client connected from ${peer}`);
    const session = createSession();
    const decoder = createDecoder();

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
    start(port) {
      server.listen(port, () => console.log(`NDC host simulator listening on port ${port}`));
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
