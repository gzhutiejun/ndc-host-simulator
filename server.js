const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

// Load configuration
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Message mapping configuration
const messageMapping = config.messageMapping || {};

// Extract opcode from message (assuming opcode is at the beginning of the message)
// This is a simple implementation - adjust based on your actual message format
function extractOpcode(message) {
  // Try to extract opcode - common formats:
  // 1. First N characters (e.g., first 5 characters)
  // 2. JSON format with opcode field
  // 3. Fixed position in binary format
  
  // Default: try JSON first, then first 5 characters
  try {
    const parsed = JSON.parse(message.toString());
    if (parsed.opcode) {
      return parsed.opcode;
    }
  } catch (e) {
    // Not JSON, try string extraction
  }
  
  // Extract first 5 characters as opcode (adjust length as needed)
  const messageStr = message.toString().trim();
  if (messageStr.length >= 5) {
    return messageStr.substring(0, 5);
  }
  return messageStr;
}

// Get response message based on opcode
function getResponseMessage(opcode) {
  return messageMapping[opcode] || `Unknown opcode: ${opcode}`;
}

// Create TCP server
function createServer() {
  const server = net.createServer((socket) => {
    console.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
    
    socket.on('data', (data) => {
      console.log(`Received data: ${data.toString()}`);
      
      // Extract opcode from received message
      const opcode = extractOpcode(data);
      console.log(`Extracted opcode: ${opcode}`);
      
      // Get response message based on opcode
      const responseMessage = getResponseMessage(opcode);
      console.log(`Sending response: ${responseMessage}`);
      
      // Send response back to client
      socket.write(responseMessage);
    });
    
    socket.on('end', () => {
      console.log('Client disconnected');
    });
    
    socket.on('error', (err) => {
      console.error(`Socket error: ${err.message}`);
    });
  });
  
  server.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
  });
  
  return server;
}

// Create TLS server
function createTLSServer() {
  // Check if TLS certificates are configured
  if (!config.tls || !config.tls.key || !config.tls.cert) {
    console.error('TLS enabled but certificates not configured in config.json');
    process.exit(1);
  }
  
  const options = {
    key: fs.readFileSync(config.tls.key),
    cert: fs.readFileSync(config.tls.cert),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2'
  };
  
  const server = tls.createServer(options, (socket) => {
    console.log(`TLS Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
    console.log(`Authorized: ${socket.authorized}`);
    
    socket.on('data', (data) => {
      console.log(`Received data: ${data.toString()}`);
      
      // Extract opcode from received message
      const opcode = extractOpcode(data);
      console.log(`Extracted opcode: ${opcode}`);
      
      // Get response message based on opcode
      const responseMessage = getResponseMessage(opcode);
      console.log(`Sending response: ${responseMessage}`);
      
      // Send response back to client
      socket.write(responseMessage);
    });
    
    socket.on('end', () => {
      console.log('TLS Client disconnected');
    });
    
    socket.on('error', (err) => {
      console.error(`TLS Socket error: ${err.message}`);
    });
  });
  
  server.on('error', (err) => {
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

