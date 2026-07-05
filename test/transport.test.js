const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { createTransport } = require('../src/transport');

test('TLS enabled without certs throws', () => {
  assert.throws(() => createTransport({ enableTLS: true, tls: {} }, () => {}), /certificate/i);
});

test('TCP server invokes onConnection and can echo', async () => {
  const received = [];
  const server = createTransport({ enableTLS: false }, (socket) => {
    socket.on('data', (d) => {
      received.push(d);
      socket.write(d); // echo
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const echoed = await new Promise((resolve, reject) => {
    const client = net.createConnection({ port }, () => client.write(Buffer.from([1, 2, 3])));
    client.on('data', (d) => {
      resolve(d);
      client.end();
    });
    client.on('error', reject);
  });
  assert.deepStrictEqual([...echoed], [1, 2, 3]);
  assert.strictEqual(received.length, 1);
  await new Promise((resolve) => server.close(resolve));
});
