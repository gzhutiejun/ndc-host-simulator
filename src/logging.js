const fs = require('node:fs');
const path = require('node:path');

function hexDump(buf) {
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.subarray(i, i + 16);
    const offset = i.toString(16).padStart(8, '0');
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${offset}  ${hex.padEnd(16 * 3 - 1)}  |${ascii}|`);
  }
  return lines.join('\n');
}

function createLogger({ dir, now = () => new Date() } = {}) {
  let file = null;
  function ensureFile() {
    if (file) return file;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    file = path.join(dir, `session-${stamp}.log`);
    return file;
  }
  const logger = {
    get file() {
      return file;
    },
    record(direction, buf, meta = {}) {
      const f = ensureFile();
      const ts = now().toISOString();
      const header = `[${ts}] ${direction} ${meta.type || ''} rule=${meta.rule || '-'} (${buf.length} bytes)`;
      const block = `${header}\n${hexDump(buf)}\n`;
      console.log(block);
      fs.appendFileSync(f, block + '\n');
    },
  };
  return logger;
}

module.exports = { hexDump, createLogger };
