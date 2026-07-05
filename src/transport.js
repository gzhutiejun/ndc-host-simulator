const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');

function createTransport(config, onConnection) {
  if (config.enableTLS === true) {
    if (!config.tls || !config.tls.key || !config.tls.cert) {
      throw new Error('TLS enabled but certificate/key not configured in config.tls');
    }
    const options = {
      key: fs.readFileSync(config.tls.key),
      cert: fs.readFileSync(config.tls.cert),
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    };
    return tls.createServer(options, onConnection);
  }
  return net.createServer(onConnection);
}

module.exports = { createTransport };
