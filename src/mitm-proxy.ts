import { createServer, createConnection, Socket } from "node:net";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import forge from "node-forge";
import { spawnSync } from "node:child_process";
import * as recorder from "./commands.ts";
import * as deviceLogin from "./handlers/device-login-emulator.ts";
import * as offlineStore from "./offline-store.ts";
import * as splitConsole from "./split-console.ts";
import { ts, agentTag, agentName, colorMethod, colorStatus, httpLogLine, generalLogLine, getTps, isDebug } from "./split-console.ts";
import { getProjectRoot } from "./shared.ts";
import { initModels, getModelIds as getOpencodeModelIds } from "./handlers/opencode-client.ts";
import { fetchModels as fetchOpenCommandModels, hasKeys as hasOpenCommandKeys } from "./handlers/opencommand-client.ts";

// Real IP cache to bypass hosts file for non-intercepted requests
const INTERCEPTED_HOSTS = ["github.com", "www.github.com", "api.github.com", "api.githubcopilot.com", "copilot-proxy.githubusercontent.com", "api.individual.githubcopilot.com", "origin-tracker.individual.githubcopilot.com", "proxy.individual.githubcopilot.com", "telemetry.individual.githubcopilot.com"];
const REAL_IPS: Record<string, string> = {
  "github.com": "140.82.121.4",
  "www.github.com": "140.82.121.3",
  "api.github.com": "140.82.121.5",
  "api.githubcopilot.com": "140.82.114.21",
  "copilot-proxy.githubusercontent.com": "4.225.11.192",
  "api.individual.githubcopilot.com": "140.82.113.22",
  "origin-tracker.individual.githubcopilot.com": "140.82.113.22",
  "proxy.individual.githubcopilot.com": "4.225.11.192",
  "telemetry.individual.githubcopilot.com": "140.82.113.21",
  "127.0.0.1": "127.0.0.1",
};
const realIps = new Map<string, string>();

async function getRealIp(host: string): Promise<string> {
  if (realIps.has(host)) return realIps.get(host)!;
  if (REAL_IPS[host]) {
    realIps.set(host, REAL_IPS[host]);
    return REAL_IPS[host];
  }
  return host;
}

// Configuration � mode from launch args or gc2xy_MODE env
const ARGS = new Set(process.argv.slice(1));
const IS_PROXY = ARGS.has("--mode-3") || process.env.gc2xy_MODE === "proxy";
const IS_HYBRID = ARGS.has("--mode-2") || process.env.gc2xy_MODE === "hybrid";
const IS_MOCK = !IS_PROXY && !IS_HYBRID;
const IIS_PROXY = process.env.IIS_PROXY === "1";
const HTTP_PORT = parseInt(process.env.gc2xy_HTTP_PORT || (IIS_PROXY ? "3080" : "80"));
const HTTPS_PORT = parseInt(process.env.gc2xy_HTTPS_PORT || "443");
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "8080");
const TARGET_HOST = process.env.TARGET_HOST || "github.com";
const LOG_DIR = (process.env.LOG_DIR || join(getProjectRoot(), ".proxy-logs")).trim();
const CERT_DIR = (process.env.CERT_DIR || join(getProjectRoot(), ".certs")).trim();
const INTERCEPT_MODE = process.env.INTERCEPT_MODE || "hosts";

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(CERT_DIR, { recursive: true });

try { unlinkSync("package-lock.json"); } catch {}

// Logging with datetime + mode suffix
const modeLogStr = IS_PROXY ? "PROXY" : IS_HYBRID ? "hybrid" : "mock";
const now = new Date();
const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
const logFile = join(LOG_DIR, `traffic-${dateStr}-${modeLogStr}.log`);
const logStream = createWriteStream(logFile, { flags: "a" });
let requestCounter = 0;
let cacheHitCount = 0;
let lastAgentName = "";

function debugLog(msg: string) {
  const iso = new Date().toISOString();
  splitConsole.debugLog(generalLogLine("DEBUG", msg));
  logStream.write(JSON.stringify({ timestamp: iso, level: "DEBUG", msg }) + "\n");
}

function log(level: string, msg: string, data: Record<string, any> = {}) {
  const iso = new Date().toISOString();
  if (level === "DEBUG") {
    splitConsole.debugLog(generalLogLine(level, msg));
  } else {
    console.log(generalLogLine(level, msg));
  }
  logStream.write(JSON.stringify({ timestamp: iso, level, msg, ...data }) + "\n");
}

function logPlainEnglish(reqNum: number, direction: "REQUEST" | "RESPONSE", method: string, url: string, host: string, statusCode: number | null, headers: Record<string, string>, body: string | null, agentOverride?: string) {
  const agent = agentOverride || agentTag(headers);
  const dir = direction === "REQUEST" ? "REQ" : "RES";

  const isDebugLine = (headers["editor-version"] || "").startsWith("VS/VisualStudio") ||
    (agentOverride || "").includes("VS") || agent.includes("VS") || agent.includes("TEAM") || agent.includes("APP") || agent.includes("GO-HT") ||
    url.includes("/telemetry") || url.includes("/agents/sessions/") || url === "/" || url === "/favicon.ico" ||
    headers["x-gc2xy-test"] === "1";
  if (isDebugLine) {
    splitConsole.debugLog(httpLogLine(dir, method, url, statusCode, agent));
  } else {
    console.log(httpLogLine(dir, method, url, statusCode, agent));
  }

  logStream.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    requestNumber: reqNum,
    direction,
    method,
    url,
    host,
    statusCode,
    headers,
    bodyLength: body?.length ?? 0,
    bodyPreview: body ? body.slice(0, 1000) : null,
  }) + "\n");

  if (reqNum % 5 === 0 || reqNum === 1) {
    splitConsole.drawStatusBar({
      mode: IS_PROXY ? "PROXY" : IS_HYBRID ? "HYBRID" : "MOCK",
      requests: reqNum,
      port: IIS_PROXY ? `443 → ${HTTP_PORT}` : (INTERCEPT_MODE === "hosts" ? 443 : PROXY_PORT),
      target: TARGET_HOST,
      cacheHits: cacheHitCount,
      PROXY: IS_PROXY,
      lastAgent: lastAgentName,
      tps: getTps(),
      runtime: runtimeTag,
    });
  }
}

// CA management using node-forge
const CA_KEY_PATH = join(CERT_DIR, "ca-key.pem");
const CA_CERT_PATH = join(CERT_DIR, "ca-cert.pem");
let caPrivateKey: forge.pki.PrivateKey;
let caPublicKey: forge.pki.PublicKey;
let caCert: forge.pki.Certificate;

type ForgeKeyPair = { publicKey: forge.pki.PublicKey; privateKey: forge.pki.PrivateKey };

function generateForgeKeyPair(): ForgeKeyPair {
  const { publicKey: pubPem, privateKey: privPem } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return {
    publicKey: forge.pki.publicKeyFromPem(pubPem),
    privateKey: forge.pki.privateKeyFromPem(privPem),
  };
}

function getCertThumbprint(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert));
  const md = forge.md.sha1.create();
  md.update(der.getBytes());
  return md.digest().toHex().toUpperCase();
}

function installCACert() {
  if (process.platform !== "win32") return;
  try {
    // Compute thumbprint of the cert we want to install
    const cert = caCert ?? forge.pki.certificateFromPem(readFileSync(CA_CERT_PATH, "utf8"));
    const thumbprint = getCertThumbprint(cert);

    // Check if already installed with same thumbprint
    const store = spawnSync("certutil", ["-store", "ROOT"], { encoding: "utf8", timeout: 10000 });
    if (store.stdout && store.stdout.toUpperCase().includes(thumbprint)) {
      log("INFO", "CA cert already installed in Windows Trusted Root Store");
      return;
    }

    log("INFO", "Installing CA cert to Windows Trusted Root Store...");
    spawnSync("certutil", ["-delstore", "ROOT", "MITM Debug Proxy"], { stdio: "ignore", timeout: 10000 });
    const r = spawnSync("certutil", ["-addstore", "ROOT", CA_CERT_PATH], { stdio: "ignore", timeout: 10000 });
    if (r.status === 0) {
      log("INFO", "CA cert installed to Windows Trusted Root Store");
    } else {
      log("WARN", `CA cert install failed (certutil exit ${r.status}) — may need admin rights`);
    }
  } catch (e) {
    log("WARN", `CA cert install error: ${e}`);
  }
}

function initCA() {
  if (existsSync(CA_KEY_PATH) && existsSync(CA_CERT_PATH)) {
    log("INFO", "Loading existing CA");
    const keyPem = readFileSync(CA_KEY_PATH, "utf8");
    const certPem = readFileSync(CA_CERT_PATH, "utf8");
    caPrivateKey = forge.pki.privateKeyFromPem(keyPem);
    caCert = forge.pki.certificateFromPem(certPem);
    caPublicKey = caCert.publicKey;
  } else {
    log("INFO", "Generating CA key pair...");
    const kp = generateForgeKeyPair();
    caPrivateKey = kp.privateKey;
    caPublicKey = kp.publicKey;

    caCert = forge.pki.createCertificate();
    caCert.publicKey = caPublicKey;
    caCert.serialNumber = "01";
    caCert.validity.notBefore = new Date();
    caCert.validity.notBefore.setFullYear(caCert.validity.notBefore.getFullYear() - 1);
    caCert.validity.notAfter = new Date();
    caCert.validity.notAfter.setFullYear(caCert.validity.notAfter.getFullYear() + 10);

    const attrs = [
      { name: "commonName", value: "MITM Debug Proxy" },
      { name: "organizationName", value: "Debug" },
      { name: "countryName", value: "US" },
    ];
    caCert.setSubject(attrs);
    caCert.setIssuer(attrs);

    caCert.setExtensions([
      { name: "basicConstraints", cA: true },
      { name: "keyUsage", keyCertSign: true, digitalSignature: true, nonRepudiation: true, keyEncipherment: true, dataEncipherment: true },
      { name: "extKeyUsage", serverAuth: true, clientAuth: true },
      { name: "subjectKeyIdentifier" },
    ]);

    caCert.sign(caPrivateKey, forge.md.sha256.create());

    const keyPem = forge.pki.privateKeyToPem(caPrivateKey);
    const certPem = forge.pki.certificateToPem(caCert);

    writeFileSync(CA_KEY_PATH, keyPem);
    writeFileSync(CA_CERT_PATH, certPem);
    log("INFO", "CA certificate generated with node-forge");
  }

  installCACert();
}

// Cert cache
const certCache = new Map<string, { key: Buffer; cert: Buffer }>();

function getServerCert(host: string) {
  const cacheKey = `host:${host}`;
  if (certCache.has(cacheKey)) return certCache.get(cacheKey)!;

  const keyPath = join(CERT_DIR, `${host}-key.pem`);
  const certPath = join(CERT_DIR, `${host}-cert.pem`);

  if (existsSync(keyPath) && existsSync(certPath)) {
    const ctx = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    certCache.set(cacheKey, ctx);
    return ctx;
  }

  log("INFO", `Generating cert for ${host}`);

  const serverKey = generateForgeKeyPair();
  const serverCert = forge.pki.createCertificate();
  serverCert.publicKey = serverKey.publicKey;
  serverCert.serialNumber = Math.floor(Math.random() * 1000000000).toString(16).padStart(8, "0");
  serverCert.validity.notBefore = new Date();
  serverCert.validity.notBefore.setFullYear(serverCert.validity.notBefore.getFullYear() - 1);
  serverCert.validity.notAfter = new Date();
  serverCert.validity.notAfter.setFullYear(serverCert.validity.notAfter.getFullYear() + 1);

  serverCert.setSubject([{ name: "commonName", value: host }]);
  serverCert.setIssuer(caCert.subject.attributes);

  function ipToForgeBytes(ip: string): string {
    return String.fromCharCode(...ip.split(".").map(Number));
  }

  const altNames: { type: number; value: any }[] = [
    { type: 2, value: host },
    { type: 2, value: `*.${host}` },
    { type: 2, value: "localhost" },
    { type: 7, value: ipToForgeBytes("127.0.0.1") },
  ];

  serverCert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true, clientAuth: true },
    { name: "subjectAltName", altNames },
    { name: "subjectKeyIdentifier" },
  ]);

  serverCert.sign(caPrivateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(serverKey.privateKey);
  const certPem = forge.pki.certificateToPem(serverCert);

  const ctx = { key: Buffer.from(keyPem), cert: Buffer.from(certPem) };
  certCache.set(cacheKey, ctx);

  writeFileSync(keyPath, ctx.key);
  writeFileSync(certPath, ctx.cert);

  return ctx;
}

// Generate a single cert that covers ALL intercepted hosts (no SNI needed)
function getInterceptCert() {
  const cacheKey = "__intercept__";
  if (certCache.has(cacheKey)) return certCache.get(cacheKey)!;

  const certPath = join(CERT_DIR, "intercept-cert.pem");
  const keyPath = join(CERT_DIR, "intercept-key.pem");

  if (existsSync(keyPath) && existsSync(certPath)) {
    const certPem = readFileSync(certPath, "utf8");
    const cert = forge.pki.certificateFromPem(certPem);
    const sanExt = cert.extensions?.find(e => e.name === "subjectAltName");
    const existingHosts = sanExt?.altNames?.map((a: any) => a.value) || [];
    const allHostsCovered = INTERCEPTED_HOSTS.every(h =>
      existingHosts.some((v: string) => v === h)
    );
    if (allHostsCovered) {
      const ctx = { key: readFileSync(keyPath), cert: certPem };
      certCache.set(cacheKey, ctx);
      return ctx;
    }
    log("INFO", "Cached cert is missing SANs for new hosts, regenerating...");
  }

  log("INFO", "Generating unified cert for all intercepted hosts...");

  const serverKey = generateForgeKeyPair();
  const serverCert = forge.pki.createCertificate();
  serverCert.publicKey = serverKey.publicKey;
  serverCert.serialNumber = Math.floor(Math.random() * 1000000000).toString(16).padStart(8, "0");
  serverCert.validity.notBefore = new Date();
  serverCert.validity.notBefore.setFullYear(serverCert.validity.notBefore.getFullYear() - 1);
  serverCert.validity.notAfter = new Date();
  serverCert.validity.notAfter.setFullYear(serverCert.validity.notAfter.getFullYear() + 1);

  serverCert.setSubject([{ name: "commonName", value: "MITM Proxy" }]);
  serverCert.setIssuer(caCert.subject.attributes);

  function ipToForgeBytes(ip: string): string {
    return String.fromCharCode(...ip.split(".").map(Number));
  }

  const altNames: { type: number; value: any }[] = [
    { type: 2, value: "localhost" },
    { type: 7, value: ipToForgeBytes("127.0.0.1") },
  ];
  for (const h of INTERCEPTED_HOSTS) {
    if (!altNames.some(a => a.value === h)) {
      altNames.push({ type: 2, value: h });
    }
  }

  serverCert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true, clientAuth: true },
    { name: "subjectAltName", altNames },
    { name: "subjectKeyIdentifier" },
  ]);

  serverCert.sign(caPrivateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(serverKey.privateKey);
  const certPem = forge.pki.certificateToPem(serverCert);

  const ctx = { key: Buffer.from(keyPem), cert: Buffer.from(certPem) };
  certCache.set(cacheKey, ctx);

  writeFileSync(keyPath, ctx.key);
  writeFileSync(certPath, ctx.cert);

  log("INFO", "Unified cert generated with SAN for all hosts");
  return ctx;
}

// Parse HTTP request
function parseHttpRequest(buffer: Buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const headerStr = buffer.slice(0, headerEnd).toString();
  const lines = headerStr.split("\r\n");
  const [method, url] = lines[0].split(" ");
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(": ");
    if (colonIdx > 0) headers[lines[i].slice(0, colonIdx).toLowerCase()] = lines[i].slice(colonIdx + 2);
  }
  return { method, url, headers, bodyOffset: headerEnd + 4 };
}

// Interceptor system
interface InterceptedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
  hostname: string;
  port: number;
  blocked: boolean;
  clientSocket?: any;
  _responseSent?: boolean;
  response?: {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    body: Buffer;
  };
}

interface InterceptedResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

type RequestInterceptor = (req: InterceptedRequest) => void | Promise<void>;
type ResponseInterceptor = (res: InterceptedResponse) => void | Promise<void>;

const requestInterceptors: RequestInterceptor[] = [];
const responseInterceptors: ResponseInterceptor[] = [];

function addRequestInterceptor(fn: RequestInterceptor) {
  requestInterceptors.push(fn);
}

function addResponseInterceptor(fn: ResponseInterceptor) {
  responseInterceptors.push(fn);
}

async function runRequestInterceptors(req: InterceptedRequest): Promise<InterceptedRequest> {
  for (const fn of requestInterceptors) {
    await fn(req);
  }
  return req;
}

async function runResponseInterceptors(res: InterceptedResponse): Promise<InterceptedResponse> {
  for (const fn of responseInterceptors) {
    await fn(res);
  }
  return res;
}

// Device login bypass interceptor
addRequestInterceptor(async (req) => {
  if (req.response) return;
  if (IS_PROXY) return;
  try {
    const handlerInput: HandlerInput = {
      method: req.method, url: req.url, headers: req.headers, body: req.body,
      hostname: req.hostname, port: req.port, clientSocket: req.clientSocket,
    };
    const result = await deviceLogin.handleDeviceLogin(handlerInput);
    if (result.handled && result.response) {
      if (result.response._streamed) {
        req._responseSent = true;
      } else {
        req.response = {
          statusCode: result.response.statusCode,
          statusMessage: result.response.statusMessage || "OK",
          headers: result.response.headers,
          body: result.response.body,
        };
      }
    }
  } catch (e) {
    log("ERROR", `Fake handler: ${(e as Error).message || e}`);
    req.response = { statusCode: 200, statusMessage: "OK", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: (e as Error).message || "handler crashed" })) };
  }
});

// Hosts file management
const HOSTS_PATH = "C:\\Windows\\System32\\drivers\\etc\\hosts";

function setupHostsRedirect() {
  log("DEBUG", "Setting up hosts file redirect...");
  try {
    const hosts = readFileSync(HOSTS_PATH, "utf8");
    const markers = ["# BEGIN gc2xy PROXY", "# END gc2xy PROXY"];
    if (hosts.includes(markers[0])) {
      log("DEBUG", "Hosts redirect already exists and is up to date");
      return;
    }
    appendFileSync(HOSTS_PATH, `\n${markers[0]}\n127.0.0.1 ${INTERCEPTED_HOSTS.join(" ")}\n${markers[1]}\n`);
    log("INFO", `Added ${INTERCEPTED_HOSTS.length} hosts to hosts file redirect`);
  } catch (e: any) {
    log("ERROR", `Failed to modify hosts file: ${e.message}`);
    log("INFO", "Run as Administrator to modify hosts file");
  }
}

function cleanupHostsRedirect() {
  log("INFO", "Cleaning up hosts file...");
  try {
    const hosts = readFileSync(HOSTS_PATH, "utf8");
    const startMarker = "# BEGIN gc2xy PROXY";
    const endMarker = "# END gc2xy PROXY";
    const startIdx = hosts.indexOf(startMarker);
    const endIdx = hosts.indexOf(endMarker);
    if (startIdx !== -1 && endIdx !== -1) {
      const before = hosts.substring(0, startIdx);
      const after = hosts.substring(endIdx + endMarker.length);
      writeFileSync(HOSTS_PATH, (before + after).replace(/\n{3,}/g, "\n\n").trimStart() + "\n");
      log("INFO", "Removed hosts redirect");
    } else {
      log("DEBUG", "No gc2xy markers found in hosts file");
    }
  } catch (e: any) {
    log("ERROR", `Failed to cleanup hosts file: ${e.message}`);
  }
}

// Forward request through interceptor
async function forwardWithInterceptor(client: TLSSocket | Socket, method: string, url: string, headers: Record<string, string>, host: string, port: number, bodyOffset: number, buffer: Buffer, contentLen?: number) {
  requestCounter++;
  const reqNum = requestCounter;

  const bodyEnd = contentLen ? bodyOffset + contentLen : buffer.length;
  const reqBody = buffer.length > bodyOffset ? buffer.slice(bodyOffset, bodyEnd) : null;

  const _newAgent = agentName(headers);
  const _whitelisted = ["Visual Studio", "GitHub Copilot Desktop"]; // agents worth showing in status bar
  if (_whitelisted.some(w => _newAgent.startsWith(w))) lastAgentName = _newAgent;

  const editorVer = headers["editor-version"] || "";
  if (editorVer.startsWith("VS/VisualStudio")) {
    const baggage = headers["baggage"] || "";
    const initiator = headers["x-initiator"] || "";
    const initType = baggage.match(/vs\.copilot\.InteractionType\s*=\s*(\S+)/)?.[1] || "";
    const initBy = baggage.match(/vs\.copilot\.InitiatorType\s*=\s*(\S+)/)?.[1] || "";
    const _vsMsg = `[VS DETECTED] ${method} ${url} � editor: ${editorVer} | initiator=${initiator} | mode=${initType} | by=${initBy}`;
    const iso = new Date().toISOString();
    logStream.write(JSON.stringify({ timestamp: iso, level: "INFO", msg: _vsMsg }) + "\n");
    if (isDebug()) console.log(generalLogLine("INFO", _vsMsg));
  }

  let interceptedReq: InterceptedRequest = {
    method, url, headers: { ...headers }, body: reqBody, hostname: host, port, blocked: false,
    clientSocket: client,
  };

  await runRequestInterceptors(interceptedReq);

  if (interceptedReq.blocked) {
    client.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\nConnection: close\r\n\r\nBlocked\r\n");
    client.end();
    return;
  }

  if (interceptedReq._responseSent) {
    return;
  }

  if (interceptedReq.response) {
    log("DEBUG", `Intercepted response ${interceptedReq.response.statusCode} for ${method} ${url} � agent: ${lastAgentName}`);
    const { statusCode, statusMessage, headers: resHeaders, body: resBody } = interceptedReq.response;
    if (url.includes("/chat/completions") || url.includes("/v1/messages")) {
      console.log(`[RESP BODY] ${method} ${url} ${statusCode} | hex=${resBody.slice(0, 500).toString("hex")} | text=${resBody.slice(0, 500).toString().replace(/\n/g, "\\n")}`);
    }
    logPlainEnglish(reqNum, "RESPONSE", method, url, host, statusCode, resHeaders, resBody.toString(), agentTag(headers));
    if (recorder.isRecording) {
      recorder.recordEntry(
        { method, url, headers, body: reqBody?.toString() ?? null },
        { statusCode, statusMessage, headers: resHeaders, body: resBody.toString() },
      );
    }
    let respHeader = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
    let isSSE = false;
    for (const [key, value] of Object.entries(resHeaders)) {
      const lk = key.toLowerCase();
      if (lk === "content-type" && value.includes("text/event-stream")) isSSE = true;
      if (!["transfer-encoding", "connection", "keep-alive", "content-length"].includes(lk)) {
        respHeader += `${key}: ${value}\r\n`;
      }
    }
    if (isSSE) {
      respHeader += `Transfer-Encoding: chunked\r\n\r\n`;
      client.write(respHeader);
      const chunk = Buffer.from(resBody.length.toString(16) + "\r\n");
      client.write(chunk);
      client.write(resBody);
      client.write(Buffer.from("\r\n0\r\n\r\n"));
    } else {
      respHeader += `Content-Length: ${resBody.length}\r\nConnection: close\r\n\r\n`;
      client.write(respHeader);
      if (resBody.length > 0) client.write(resBody);
      client.end();
    }
    return;
  }

  const { method: finalMethod, url: finalUrl, headers: finalHeaders, body: finalBody, hostname: finalHost, port: finalPort } = interceptedReq;

  log("DEBUG", `No interceptor handled ${finalMethod} ${finalUrl} � forwarding upstream to ${finalHost}:${finalPort}`);
  logPlainEnglish(reqNum, "REQUEST", finalMethod, finalUrl, finalHost, null, finalHeaders, finalBody?.toString() ?? null);

  // Check replay first
  if (recorder.isReplaying) {
    const replayed = recorder.tryReplay(finalMethod, finalUrl);
    if (replayed) {
      const respBody = replayed.body ? Buffer.from(replayed.body) : Buffer.alloc(0);
      logPlainEnglish(reqNum, "RESPONSE", finalMethod, finalUrl, finalHost, replayed.statusCode, replayed.headers, replayed.body, agentTag(finalHeaders));
      let respHeader = `HTTP/1.1 ${replayed.statusCode} ${replayed.statusMessage}\r\n`;
      for (const [key, value] of Object.entries(replayed.headers)) {
        respHeader += `${key}: ${value}\r\n`;
      }
      respHeader += `Content-Length: ${respBody.length}\r\nConnection: close\r\n\r\n`;
      client.write(respHeader);
      if (respBody.length > 0) client.write(respBody);
      client.end();
      return;
    }
  }

  const useHttps = finalPort === 443;
  const upstreamHost = await getRealIp(finalHost);
  const req = (useHttps ? httpsRequest : httpRequest)({
    hostname: upstreamHost, port: finalPort, path: finalUrl, method: finalMethod,
    headers: { ...finalHeaders, host: finalHost },
    rejectUnauthorized: false,
  }, async (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", async () => {
      const body = Buffer.concat(chunks);

      let interceptedRes: InterceptedResponse = {
        statusCode: res.statusCode || 200,
        statusMessage: res.statusMessage || "OK",
        headers: { ...res.headers as Record<string, string> },
        body,
      };

      await runResponseInterceptors(interceptedRes);

      // Inject mitm_status and mitm_mode into api.github.com/ responses from upstream
      if (finalUrl === "/" && (finalHost === "api.github.com" || finalHost.startsWith("api.github.com:")) && interceptedRes.body && interceptedRes.body.length > 0) {
        try {
          let raw = interceptedRes.body;
          const ceKey = Object.keys(interceptedRes.headers).find(k => k.toLowerCase() === "content-encoding");
          const ce = ceKey ? interceptedRes.headers[ceKey] : "";
          if (ce.includes("gzip")) {
            raw = gunzipSync(raw);
            delete interceptedRes.headers[ceKey];
          }
          const json = JSON.parse(raw.toString("utf8"));
          if (typeof json === "object" && json !== null) {
            json.mitm_status = "active";
            json.mitm_mode = IS_PROXY ? "proxy" : IS_HYBRID ? "hybrid" : "mock";
            interceptedRes.body = Buffer.from(JSON.stringify(json));
            const clKey = Object.keys(interceptedRes.headers).find(k => k.toLowerCase() === "content-length");
            if (clKey) interceptedRes.headers[clKey] = String(interceptedRes.body.length);
          }
        } catch {}
      }

      const { statusCode, statusMessage, headers: resHeaders, body: resBody } = interceptedRes;

      logPlainEnglish(reqNum, "RESPONSE", finalMethod, finalUrl, finalHost, statusCode, resHeaders, resBody?.toString() ?? null, agentTag(finalHeaders));

      // Save to cache (skip chat completions)
      if (!finalUrl.includes("/chat/completions") && !finalUrl.includes("/v1/messages")) {
        offlineStore.saveToStore(finalMethod, finalUrl, finalHost, statusCode, statusMessage, resHeaders, resBody ?? Buffer.alloc(0));
      }

      // Record if recording
      if (recorder.isRecording) {
        recorder.recordEntry(
          { method: finalMethod, url: finalUrl, headers: finalHeaders, body: finalBody?.toString() ?? null },
          { statusCode, statusMessage, headers: resHeaders, body: resBody?.toString() ?? null },
        );
      }

      const responseBody = resBody ?? Buffer.alloc(0);

      let respHeader = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
      for (const [key, value] of Object.entries(resHeaders)) {
        const lk = key.toLowerCase();
        if (!["transfer-encoding", "connection", "keep-alive", "content-length"].includes(lk)) {
          respHeader += `${key}: ${value}\r\n`;
        }
      }
      if (responseBody.length > 0) {
        respHeader += `Content-Length: ${responseBody.length}\r\n`;
      }
      respHeader += `Connection: close\r\n\r\n`;

      client.write(respHeader);
      if (responseBody.length > 0) client.write(responseBody);
      client.end();
    });
  });

  req.on("error", (err: Error) => {
    log("ERROR", `Upstream error: ${err.message}`);
    client.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 11\r\nConnection: close\r\n\r\nBad Gateway\r\n");
    client.end();
  });

  if (finalBody && finalBody.length > 0) req.write(finalBody);
  req.end();
}

// INTERCEPT MODE: TLS server on 443, HTTP server on 80
// When IIS_PROXY: only HTTP server (IIS handles TLS termination)
function createInterceptServers() {
  const servers: any[] = [];

  if (!IIS_PROXY) {
    const certInfo = getInterceptCert();

    const httpsServer = createTlsServer({
      key: certInfo.key,
      cert: certInfo.cert,
      ALPNProtocols: ["http/1.1"],
      requestCert: false,
      rejectUnauthorized: false,
    });

    httpsServer.on("secureConnection", (tlsSocket: TLSSocket) => {
      const host = (tlsSocket as any).servername || TARGET_HOST;
      debugLog(`TLS handshake complete for ${host}`);

      let buffer = Buffer.alloc(0);
      let requestHandled = false;

      tlsSocket.on("data", async (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        const parsed = parseHttpRequest(buffer);
        if (!parsed || requestHandled) return;

        const contentLen = parseInt(parsed.headers["content-length"] || "0", 10);
        const bodyBytes = buffer.length - parsed.bodyOffset;
        if (contentLen > 0 && bodyBytes < contentLen) {
          if (parsed.headers["expect"]?.toLowerCase() === "100-continue") {
            tlsSocket.write("HTTP/1.1 100 Continue\r\n\r\n");
          }
          return;
        }

        requestHandled = true;
        try {
          await forwardWithInterceptor(tlsSocket, parsed.method, parsed.url, parsed.headers, host, 443, parsed.bodyOffset, buffer, contentLen || undefined);
        } catch (e) {
          log("ERROR", `Handler crashed: ${(e as Error).message || e}`);
          if (!tlsSocket.destroyed) {
            tlsSocket.write("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
            tlsSocket.end();
          }
        }
      });

      tlsSocket.on("error", (err: Error) => log("ERROR", `TLS error for ${host}: ${err.message}`));
    });

    httpsServer.on("tlsClientError", (err: Error) => {
      log("ERROR", `TLS client error: ${err.message}`);
    });

    httpsServer.listen(HTTPS_PORT, "127.0.0.1", () => {
      log("INFO", `HTTPS intercept server on 127.0.0.1:${HTTPS_PORT}`);
    });
    httpsServer.on("error", (err: Error) => {
      log("ERROR", `Failed to bind HTTPS port ${HTTPS_PORT}: ${err.message}. Another process may be using it.`);
    });
    servers.push(httpsServer);
  }

  // HTTP server (always created � IIS reverse proxy uses this)
  const httpServer = createServer();
  httpServer.on("connection", (clientSocket: Socket) => {
    clientSocket.once("data", (data) => {
      handlePlainHttpRequest(clientSocket, data, IIS_PROXY ? HTTP_PORT : 80).catch((e) => log("ERROR", `HTTP handler error: ${e.message}`));
    });
  });

  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    log("INFO", `HTTP intercept server on 127.0.0.1:${HTTP_PORT}`);
  });
  httpServer.on("error", (err: Error) => {
    log("ERROR", `Failed to bind HTTP port ${HTTP_PORT}: ${err.message}. Another process may be using it.`);
  });
  servers.push(httpServer);

  return servers;
}

// PROXY MODE
function createProxyServer() {
  const proxyServer = createServer();

  proxyServer.on("connection", (clientSocket: Socket) => {
    let handled = false;

    clientSocket.once("data", (data) => {
      if (handled) return;
      const requestStr = data.toString();
      const connectMatch = requestStr.match(/^CONNECT\s+([^\s]+):(\d+)\s+HTTP\/\d\.\d/i);

      if (connectMatch) {
        const host = connectMatch[1];
        const port = parseInt(connectMatch[2]);
        log("INFO", `CONNECT ${host}:${port}`);

        if (host === TARGET_HOST || host.endsWith(`.${TARGET_HOST}`)) {
          handleProxyMitm(clientSocket, host, port);
        } else {
          handleBlindTunnel(clientSocket, host, port);
        }
        handled = true;
      } else {
        handlePlainHttpRequest(clientSocket, data, PROXY_PORT).catch((e) => log("ERROR", `HTTP handler error: ${e.message}`));
        handled = true;
      }
    });

    clientSocket.on("error", (err) => log("ERROR", `Client error: ${err.message}`));
  });

  proxyServer.listen(PROXY_PORT, () => {
    log("INFO", `Proxy server on port ${PROXY_PORT}`);
  });
  proxyServer.on("error", (err: Error) => {
    log("ERROR", `Failed to bind proxy port ${PROXY_PORT}: ${err.message}.`);
  });

  return proxyServer;
}

function handleProxyMitm(clientSocket: Socket, host: string, port: number) {
  const certInfo = getServerCert(host);
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  const tlsSocket = new TLSSocket(clientSocket, {
    isServer: true, key: certInfo.key, cert: certInfo.cert,
    requestCert: false, rejectUnauthorized: false,
  });

  let buffer = Buffer.alloc(0);
  let requestHandled = false;

  tlsSocket.on("data", async (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    const parsed = parseHttpRequest(buffer);
    if (!parsed || requestHandled) return;
    requestHandled = true;
    const pcl = parseInt(parsed.headers["content-length"] || "0", 10);
    try {
      await forwardWithInterceptor(tlsSocket, parsed.method, parsed.url, parsed.headers, host, port, parsed.bodyOffset, buffer, pcl || undefined);
    } catch (e) {
      log("ERROR", `Handler crashed: ${(e as Error).message || e}`);
      if (!tlsSocket.destroyed) {
        tlsSocket.write("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        tlsSocket.end();
      }
    }
  });

  tlsSocket.on("error", (err: Error) => log("ERROR", `TLS error for ${host}: ${err.message}`));
}

function handleBlindTunnel(clientSocket: Socket, host: string, port: number) {
  const upstream = createConnection(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  upstream.on("error", (err: Error) => {
    log("ERROR", `Upstream error ${host}:${port}: ${err.message}`);
    clientSocket.end();
  });
}

async function handlePlainHttpRequest(clientSocket: Socket, data: Buffer, port: number) {
  const parsed = parseHttpRequest(data);
  if (!parsed) {
    clientSocket.end();
    return;
  }

  const { method, url, headers: allHeaders, bodyOffset } = parsed;
  let host = TARGET_HOST;
  const hostHeader = allHeaders["host"] || "";
  if (hostHeader) {
    host = hostHeader.split(":")[0];
  }

  log("INFO", `HTTP: ${method} ${url} -> ${host}:${port}`);

  // Dashboard API routes
  if (host === "dashboard" || host === "localhost" || host === "127.0.0.1") {
    // GET /dashboard - serve dashboard HTML
    if (method === "GET" && (url === "/dashboard" || url === "/dashboard/" || url === "/")) {
      const dashboardPath = join(getProjectRoot(), "dashboard.html");
      if (existsSync(dashboardPath)) {
        const html = readFileSync(dashboardPath, "utf8");
        const resp = `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`;
        clientSocket.write(resp);
        clientSocket.end();
        return;
      }
      const notFound = "Dashboard not found";
      const resp404 = `HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(notFound)}\r\nConnection: close\r\n\r\n${notFound}`;
      clientSocket.write(resp404);
      clientSocket.end();
      return;
    }
    
    // GET /health
    if (method === "GET" && url === "/health") {
      const healthData = {
        status: "ok",
        version: "3.0",
        mode: IS_PROXY ? "PROXY" : IS_HYBRID ? "HYBRID" : "MOCK",
        runtime: runtimeTag,
        platform: process.platform + "-" + process.arch,
        cwd: process.cwd(),
      };
      const body = JSON.stringify(healthData);
      const resp = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
      clientSocket.write(resp);
      clientSocket.end();
      return;
    }
    
    // GET /api/config
    if (method === "GET" && url === "/api/config") {
      const configData = {
        mode: IS_PROXY ? "PROXY" : IS_HYBRID ? "HYBRID" : "MOCK",
        httpPort: HTTP_PORT,
        httpsPort: HTTPS_PORT,
        iisProxy: IIS_PROXY,
        enableOpenCommand: process.env.ENABLE_OPENCOMMAND === "true",
      };
      const body = JSON.stringify(configData);
      const resp = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
      clientSocket.write(resp);
      clientSocket.end();
      return;
    }
    
    // POST /api/config
    if (method === "POST" && url === "/api/config") {
      const bodyStr = data.slice(bodyOffset).toString("utf8");
      try {
        const newConfig = JSON.parse(bodyStr);
        log("INFO", `Dashboard config update: ${JSON.stringify(newConfig)}`);
        const respBody = JSON.stringify({ success: true, config: newConfig });
        const resp = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${respBody.length}\r\nConnection: close\r\n\r\n${respBody}`;
        clientSocket.write(resp);
        clientSocket.end();
        return;
      } catch (e: any) {
        const errBody = JSON.stringify({ error: e.message });
        const resp = `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${errBody.length}\r\nConnection: close\r\n\r\n${errBody}`;
        clientSocket.write(resp);
        clientSocket.end();
        return;
      }
    }
  }
  
  // Mock GHCP app IPC endpoints (used for browser preview lifecycle)
  if (host === "ipc.localhost") {
    const body = JSON.stringify({ success: true, mock: "gc2xy" });
    const resp = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    clientSocket.write(resp);
    clientSocket.end();
    return;
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(allHeaders)) {
    if (!["host", "proxy-connection", "connection"].includes(key)) {
      headers[key] = value;
    }
  }

  // Extract body from buffer
  const contentLen = parseInt(allHeaders["content-length"] || "0", 10);
  const body = contentLen > 0 && bodyOffset + contentLen <= data.length
    ? data.slice(bodyOffset, bodyOffset + contentLen)
    : null;

  // Run interceptor chain (same as TLS path)
  if (!IS_PROXY) {
    try {
      const interceptedReq: InterceptedRequest = {
        method, url, headers, body, hostname: host, port,
        blocked: false, clientSocket: clientSocket as any,
      };
      await runRequestInterceptors(interceptedReq);
      if (interceptedReq.response && !(interceptedReq as any)._responseSent) {
        const { statusCode, statusMessage, headers: respHeaders, body: respBody } = interceptedReq.response;
        let resp = `HTTP/1.1 ${statusCode} ${statusMessage || "OK"}\r\n`;
        for (const [k, v] of Object.entries(respHeaders)) {
          resp += `${k}: ${v}\r\n`;
        }
        resp += `Connection: close\r\nContent-Length: ${respBody.length}\r\n\r\n`;
        clientSocket.write(resp);
        clientSocket.write(respBody);
        clientSocket.end();
        return;
      }
    } catch (e) {
      log("ERROR", `Fake handler (HTTP): ${(e as Error).message || e}`);
    }
  }

  const useHttps = IIS_PROXY
    ? (headers["x-forwarded-proto"] === "https" || port === 443 || port === PROXY_PORT)
    : (port === 443 || port === PROXY_PORT);
  const targetPort = useHttps ? 443 : 80;
  const upstreamHost = await getRealIp(host);

  const req = (useHttps ? httpsRequest : httpRequest)({
    hostname: upstreamHost, port: targetPort, path: url, method,
    headers: { ...headers, host },
    rejectUnauthorized: false,
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => {
      const body = Buffer.concat(chunks);
      logPlainEnglish(++requestCounter, "REQUEST", method, url, host, null, headers, null);
      logPlainEnglish(requestCounter, "RESPONSE", method, url, host, res.statusCode || 0, res.headers, body.toString());
      let respHeader = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
      for (const [key, value] of Object.entries(res.headers)) {
        respHeader += `${key}: ${value}\r\n`;
      }
      respHeader += "\r\n";
      clientSocket.write(respHeader);
      clientSocket.write(body);
      clientSocket.end();
    });
  });

  req.on("error", (err: Error) => {
    log("ERROR", `HTTP error: ${err.message}`);
    clientSocket.end();
  });
  if (body) req.write(body);
  req.end();
}

// Start
initCA();

// Runtime detection for status bar
const isBun = typeof (globalThis as any).Bun !== "undefined";
function detectHost(): string {
  try {
    let pid = process.pid;
    for (let i = 0; i < 32; i++) {
      let out = "";
      // Try Get-WmiObject first
      const r1 = spawnSync("powershell", ["-NoP", "-Command",
        `try{$c=Get-WmiObject Win32_Process -Filter 'ProcessId=${pid}';if($c){Write-Host ($c.Name+'|'+$c.ParentProcessId)}}catch{}`
      ], { encoding: "utf8", timeout: 3000, windowsHide: true });
      if (r1.stdout?.trim()) {
        out = r1.stdout.trim();
      } else {
        // Fallback to Get-CimInstance (PowerShell 7+)
        const r2 = spawnSync("powershell", ["-NoP", "-Command",
          `try{$c=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($c){Write-Host ($c.Name+'|'+$c.ParentProcessId)}}catch{}`
        ], { encoding: "utf8", timeout: 3000, windowsHide: true });
        if (r2.stdout?.trim()) out = r2.stdout.trim();
      }
      if (!out) break;
      const parts = out.split("|");
      const name = (parts[0] || "").toLowerCase();
      if (name.includes("windowsterminal") || name.includes("openconsole") || name.includes("conhost")) {
        return "wterm.exe";
      }
      pid = parseInt(parts[1], 10);
      if (!pid || pid <= 0) break;
    }
  } catch {}
  // Pragmatic fallback: if Windows Terminal is running on this machine, assume we're in it
  try {
    const r = spawnSync("tasklist", ["/fi", "IMAGENAME eq WindowsTerminal.exe"],
      { encoding: "utf8", timeout: 2000, windowsHide: true });
    if (r.stdout && r.stdout.toLowerCase().includes("windowsterminal")) {
      return "wterm.exe";
    }
  } catch {}
  return "cmd.exe";
}
const host = detectHost();
const runtimeTag = `${host}/${isBun ? "BUN" : "NODE"}`;

// Initialize split console (status bar at top, logs scroll below)
splitConsole.initSplitConsole();

// Save proxy's terminal host PID for cleanup scripts to close old tabs
try {
  const r = spawnSync("powershell", ["-NoP", "-Command",
    `$p=${process.pid};while($p-gt0){try{$c=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p);if(-not$c){break};$n=$c.Name;if($n-match'WindowsTerminal|OpenConsole|conhost|cmd|powershell'){Write-Host -NoNewline $p;break};$p=$c.ParentProcessId}catch{break}}`
  ], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (r.stdout?.trim()) writeFileSync(".proxy-host-pid", r.stdout.trim() + "\n", "utf-8");
} catch {}

// Preload models at startup so the model list (?) is populated
initModels().catch(() => {});
// Load OpenCommand models if enabled
if (process.env.ENABLE_OPENCOMMAND === "true" && hasOpenCommandKeys()) {
  fetchOpenCommandModels().then((ocModels) => {
    if (ocModels.length > 0) {
      log("INFO", `Loaded ${ocModels.length} OpenCommand models`);
    }
  }).catch(() => {});
}
splitConsole.drawStatusBar({
  mode: IS_PROXY ? "PROXY" : IS_HYBRID ? "HYBRID" : "MOCK",
  requests: 0,
  port: IIS_PROXY ? `443 → ${HTTP_PORT}` : (INTERCEPT_MODE === "hosts" ? 443 : PROXY_PORT),
  target: TARGET_HOST,
  cacheHits: 0,
  PROXY: IS_PROXY,
  lastAgent: "",
  tps: 0,
  runtime: runtimeTag,
});

const MODE_EXIT: Record<string, number> = { mock: 43, hybrid: 44, PROXY: 45 };

// Wire up commands: exit codes signal launcher for restart/switch
splitConsole.onCommand((cmd: string) => {
  if (cmd === "stop") shutdown();
  else if (cmd === "restart") {
    splitConsole.restoreTerminal();
    for (const s of servers) s.close();
    logStream.end();
    try { unlinkSync(".proxy-host-pid"); } catch {}
    process.exit(42);
  } else if (cmd.startsWith("switch:")) {
    const targetMode = cmd.split(":")[1];
    const exitCode = MODE_EXIT[targetMode] || 43;
    splitConsole.restoreTerminal();
    for (const s of servers) s.close();
    logStream.end();
    try { unlinkSync(".proxy-host-pid"); } catch {}
    process.exit(exitCode);
  } else if (cmd === "record") {
    recorder.startRecording().catch(() => {});
    splitConsole.setRecording(true);
  } else if (cmd === "stoprecord") {
    if (recorder.isRecording) {
      recorder.stopRecordingAuto().then(() => splitConsole.setRecording(false)).catch(() => {});
    }
  } else if (cmd === "refresh") {
    log("INFO", "Refreshing model list...");
    initModels().catch(() => {});
  }
});

let servers: any[] = [];
if (INTERCEPT_MODE === "hosts") {
  setupHostsRedirect();
  servers = createInterceptServers();
} else {
  servers = [createProxyServer()];
}

log("DEBUG", `CA cert: ${CA_CERT_PATH}`);
log("READY", "Proxy ready � status bar above, live log below");

// Self-test: verify MITM interception works
setTimeout(() => {
  const mitmMode = IS_PROXY ? "proxy" : IS_HYBRID ? "hybrid" : "mock";
  const req = httpsRequest({
    hostname: "api.github.com",
    path: "/",
    method: "GET",
    headers: { "x-gc2xy-test": "1" },
    rejectUnauthorized: false,
    timeout: 10000,
  }, (res) => {
    let body = "";
    res.on("data", (chunk: string) => body += chunk);
    res.on("end", () => {
      log("SELF-TEST", `https://api.github.com/ → ${res.statusCode} SUCCESS (mode:${mitmMode})`);
    });
  });
  req.on("error", (err: Error) => {
    log("SELF-TEST", `https://api.github.com/ → FAILED: ${err.message}`);
  });
  req.end();
}, 2000);

function shutdown() {
  log("INFO", "Shutting down...");
  if (INTERCEPT_MODE === "hosts") cleanupHostsRedirect();
  for (const s of servers) s.close();
  logStream.end();
  splitConsole.restoreTerminal();
  try { unlinkSync(".proxy-host-pid"); } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
