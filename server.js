const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

// Load configuration
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const FS = String.fromCharCode(0x1c);
const GS = String.fromCharCode(0x1d);
const SO = String.fromCharCode(0x0e);
const SI = String.fromCharCode(0x0f);

// Message mapping configuration
const messageMapping = config.messageMapping || {};

// Extract opcode from message (assuming opcode is at the beginning of the message)
// This is a simple implementation - adjust based on your actual message format
function extractOpcode(message) {
  // Try to extract opcode - common formats:
  let opcode = null;
  try {
    const receivedMessage = new Uint8Array(message);
    // remove first two bytes (assuming they are length or header bytes)
    if (!receivedMessage || receivedMessage.length <= 2) return null;
    const fields = splitUint8ArrayBy0x1C(receivedMessage.subarray(2), {
      encoding: "utf-8",
      includeEmpty: false,
    });
    if (!fields || fields.length === 0) {
      return null;
    }

    console.log(`Received message fields: ${fields}`);

    if (fields[2] === "B0000") {
      opcode = "GIS";
    }
  } catch (e) {
    console.error(`Error extracting opcode: ${e.message}`);
  }

  return opcode;
}

/**
 * Replace <FS> with ASCII File Separator (0x1C) and convert to Uint8Array (UTF‑8).
 * @param {string} input - The source string containing "<FS>" separators.
 * @returns {Uint8Array} - UTF‑8 bytes with 0x1C inserted where "<FS>" occurred.
 */
function replaceSeperatorAndToUint8Array(input) {
  let temp = input.replace(/<FS>/g, FS);
  temp = temp.replace(/<SO>/g, SO);
  temp = temp.replace(/<GS>/g, GS);
  temp = temp.replace(/<SI>/g, SI);
  // Encode as UTF‑8 into a Uint8Array
  // TextEncoder is available in modern browsers and Node.js 11+
  return new TextEncoder().encode(temp);
}

/**
 * Split a Uint8Array by the byte separator 0x1C and decode chunks to strings.
 *
 * @param {Uint8Array} input - The byte array to split.
 * @param {Object} [options]
 * @param {string} [options.encoding='utf-8'] - Text encoding for decoding chunks.
 * @param {boolean} [options.includeEmpty=true] - Whether to include empty segments
 *        created by consecutive/leading/trailing separators.
 * @returns {string[]} - Array of decoded strings.
 */
function splitUint8ArrayBy0x1C(
  input,
  { encoding = "utf-8", includeEmpty = true } = {}
) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError("input must be a Uint8Array");
  }

  const parts = [];
  let start = 0;

  // Split on raw byte 0x1C
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 0x1c) {
      parts.push(input.subarray(start, i)); // bytes between separators
      start = i + 1; // skip the separator
    }
  }
  // Push the final segment (possibly empty if input ends with 0x1C)
  parts.push(input.subarray(start));

  // Decode each segment
  const decoder = new TextDecoder(encoding, { fatal: false });
  let strings = parts.map((segment) => decoder.decode(segment));

  // Optionally remove empty strings
  if (!includeEmpty) {
    strings = strings.filter((s) => s.length > 0);
  }

  return strings;
}

// Get response message based on opcode
function getResponseMessage(opcode) {
  return messageMapping[opcode] || `Unknown opcode: ${opcode}`;
}

/**
 * Append a 2-byte  length to the given byte array.
 * @param {Uint8Array | Int8Array} data - The input bytes.
 * @returns {Uint8Array} - New array: [len(2 bytes BE)] + data
 */
function appendLength(data) {
  // Normalize to Uint8Array for consistency
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const len = bytes.length;

  // Create result: 4 bytes for length + data
  const result = new Uint8Array(2 + len);

  // Write length

  result[0] = (len >>> 8) & 0xff;
  result[1] = len & 0xff;

  // Copy data
  result.set(bytes, 2);

  return result;
}

// Create TCP server
function createServer() {
  const server = net.createServer((socket) => {
    console.log(
      `Client connected from ${socket.remoteAddress}:${socket.remotePort}`
    );

    socket.on("data", (data) => {
      console.log(`Received data`, data);

      // Extract opcode from received message
      const opcode = extractOpcode(data);
      if (!opcode) {
        console.error("Failed to extract opcode for message");
        return;
      }

      console.log(`Extracted opcode: ${opcode}`);

      // Get response message based on opcode
      const responseMessage = getResponseMessage(opcode);

      if (!responseMessage) {
        console.error(`No response message configured for opcode: ${opcode}`);
        return;
      }

      console.log(`Sending response to ATM: ${responseMessage}`);

      const res = replaceSeperatorAndToUint8Array(responseMessage);
      // Send response back to client
      setTimeout(() => {
        socket.write(appendLength(res));
      }, 2000);
    });

    socket.on("end", () => {
      console.log("Client disconnected");
    });

    socket.on("error", (err) => {
      console.error(`Socket error: ${err.message}`);
    });
  });

  server.on("error", (err) => {
    console.error(`Server error: ${err.message}`);
  });

  return server;
}

// Create TLS server
function createTLSServer() {
  // Check if TLS certificates are configured
  if (!config.tls || !config.tls.key || !config.tls.cert) {
    console.error("TLS enabled but certificates not configured in config.json");
    process.exit(1);
  }

  const options = {
    key: fs.readFileSync(config.tls.key),
    cert: fs.readFileSync(config.tls.cert),
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  };

  const server = tls.createServer(options, (socket) => {
    console.log(
      `TLS Client connected from ${socket.remoteAddress}:${socket.remotePort}`
    );
    console.log(`Authorized: ${socket.authorized}`);

    socket.on("data", (data) => {
      console.log(`Received data: ${data.toString()}`);

      // Extract opcode from received message
      const opcode = extractOpcode(data);
      console.log(`Extracted opcode: ${opcode}`);

      // Get response message based on opcode
      const responseMessage = getResponseMessage(opcode);
      console.log(`Sending response: ${responseMessage}`);

      const res = replaceSeperatorAndToUint8Array(responseMessage);

      // Send response back to client
      setTimeout(() => {
        socket.write(appendLength(res));
      }, 2000);
    });

    socket.on("end", () => {
      console.log("TLS Client disconnected");
    });

    socket.on("error", (err) => {
      console.error(`TLS Socket error: ${err.message}`);
    });
  });

  server.on("error", (err) => {
    console.error(`TLS Server error: ${err.message}`);
  });

  return server;
}

// Start server
const port = config.port || 2000;
const enableTLS = config.enableTLS === true;

if (enableTLS) {
  console.log(`Starting TLS 1.2 server on port ${port}...`);
  const server = createTLSServer();
  server.listen(port, () => {
    console.log(`TLS 1.2 server listening on port ${port}`);
  });
} else {
  console.log(`Starting TCP server on port ${port}...`);
  const server = createServer();
  server.listen(port, () => {
    console.log(`TCP server listening on port ${port}`);
  });
}
