# NDC Host Simulator

A TCP/IP server simulator written in Node.js that listens for client connections and responds with pre-defined messages based on opcode mapping.

## Features

- TCP/IP server implementation
- Message mapping configuration via JSON
- Opcode-based message routing
- Optional TLS 1.2 support (disabled by default)
- Configurable port and settings

## Requirements

- Node.js 12.0.0 or higher

## Installation

No additional dependencies required - uses Node.js built-in modules only.

## Configuration

Edit `config.json` to configure the server:

```json
{
  "port": 8080,
  "enableTLS": false,
  "tls": {
    "key": "path/to/key.pem",
    "cert": "path/to/cert.pem"
  },
  "messageMapping": {
    "OP001": "Response message for OP001",
    "OP002": "Response message for OP002",
    "OP003": "Response message for OP003"
  }
}
```

### Configuration Options

- **port**: TCP/IP port number to listen on (default: 8080)
- **enableTLS**: Set to `true` to enable TLS 1.2, `false` to disable (default: false)
- **tls.key**: Path to TLS private key file (required when TLS is enabled)
- **tls.cert**: Path to TLS certificate file (required when TLS is enabled)
- **messageMapping**: Object mapping opcodes to response messages

## Usage

### Start the server

```bash
node server.js
```

Or using npm:

```bash
npm start
```

### Message Format

The server extracts the opcode from incoming messages in the following order:

1. **JSON format**: If the message is valid JSON with an `opcode` field, it uses that value
2. **String format**: Otherwise, it extracts the first 5 characters as the opcode

You can customize the opcode extraction logic in `server.js` by modifying the `extractOpcode()` function.

### Example Client Connection

```javascript
const net = require('net');

const client = net.createConnection({ port: 8080 }, () => {
  console.log('Connected to server');
  client.write('OP001');
});

client.on('data', (data) => {
  console.log('Response:', data.toString());
  client.end();
});

client.on('end', () => {
  console.log('Disconnected from server');
});
```

## TLS Support

To enable TLS 1.2:

1. Set `enableTLS` to `true` in `config.json`
2. Provide valid TLS certificate and key file paths
3. Ensure the certificate and key files are accessible

Example with self-signed certificate (for testing):

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes
```

Then update `config.json`:

```json
{
  "port": 8080,
  "enableTLS": true,
  "tls": {
    "key": "./key.pem",
    "cert": "./cert.pem"
  },
  "messageMapping": {
    "OP001": "TLS Response for OP001"
  }
}
```

## License

ISC
