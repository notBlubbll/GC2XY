const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');

const proxy = httpProxy.createProxyServer({ target: 'http://localhost:11434' });

const recordedRequests = [];

const server = require('http').createServer((req, res) => {
  const request = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    timestamp: new Date().toISOString(),
  };

  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    request.body = body;
    recordedRequests.push(request);

    console.log(`[${request.timestamp}] ${request.method} ${request.url}`);
    console.log('Headers:', request.headers);
    console.log('Body:', request.body);

    proxy.web(req, res, { target: 'http://localhost:11434' });
  });
});

proxy.on('proxyRes', (proxyRes, req, res) => {
  const response = {
    statusCode: proxyRes.statusCode,
    statusMessage: proxyRes.statusMessage,
    headers: proxyRes.headers,
    timestamp: new Date().toISOString(),
  };

  let body = '';
  proxyRes.on('data', (chunk) => {
    body += chunk.toString();
  });
  proxyRes.on('end', () => {
    response.body = body;

    console.log(`[${response.timestamp}] Response ${response.statusCode} ${response.statusMessage}`);
    console.log('Headers:', response.headers);
    console.log('Body:', response.body);
  });
});

server.listen(11400, () => {
  console.log('Olla Proxy server running on port 11400');
  console.log('Proxifying to http://localhost:11434');
  console.log('Recording traffic to .olla-logs...');
});

process.on('SIGINT', () => {
  console.log('\nShutting down proxy...');
  
  const recordingsDir = path.join(process.cwd(), 'olla-recordings');
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(recordingsDir, `traffic-${timestamp}.json`);
  fs.writeFileSync(filename, JSON.stringify(recordedRequests, null, 2));

  console.log(`Recorded traffic saved to ${filename}`);
  process.exit();
});