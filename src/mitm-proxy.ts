import { createServer, createConnection, Socket, Server } from "node:net";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { request as httpRequest, Agent as HttpAgent } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import forge from "node-forge";
import { spawnSync } from "node:child_process";
import * as recorder from "./commands.ts";

let _trafficLoggingEnabled = process.env.RECORD_MODE === "1";
import * as deviceLogin from "./handlers/device-login-emulator.ts";
import { isVSLegacyClient } from "./handlers/vs-legacy/index.ts";
import { isVSShell } from "./handlers/vs-shell/index.ts";
import * as offlineStore from "./offline-store.ts";
import * as splitConsole from "./split-console.ts";
import { ts, agentTag, agentName, colorMethod, colorStatus, httpLogLine, generalLogLine, getTps, isDebug } from "./split-console.ts";
import { getProjectRoot, getMode, setMode, isProxy, isHybrid, isMock, killPortProcess } from "./shared.ts";
import { addModels } from "./models.ts";
import { handleDashboard, incrementRequests as dashIncReq, createWsServer, startWsPushLoop, getVsLegacyModel } from "./handlers/dashboard-handler.ts";
import { patchSsmsMcpConfigs } from "./mcp-writer.ts";

// Real IP cache to bypass hosts file for non-intercepted requests
const INTERCEPTED_HOSTS = ["github.com", "www.github.com", "api.github.com", "api.githubcopilot.com", "copilot-proxy.githubusercontent.com", "api.individual.githubcopilot.com", "origin-tracker.individual.githubcopilot.com", "proxy.individual.githubcopilot.com", "telemetry.individual.githubcopilot.com", "dc.services.visualstudio.com"];
const REAL_IPS: Record<string, string> = {
  "github.com": "140.82.121.4",
  "www.github.com": "140.82.121.3",
  "api.github.com": "140.82.121.6",
  "api.githubcopilot.com": "140.82.113.22",
  "copilot-proxy.githubusercontent.com": "4.225.11.192",
  "api.individual.githubcopilot.com": "140.82.114.21",
  "origin-tracker.individual.githubcopilot.com": "140.82.112.21",
  "proxy.individual.githubcopilot.com": "4.225.11.192",
  "telemetry.individual.githubcopilot.com": "140.82.112.22",
  "dc.services.visualstudio.com": "20.50.88.241",
  "127.0.0.1": "127.0.0.1",
};
const realIps = new Map<string, string>();

const HTTP_UPSTREAM_AGENT = new HttpAgent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 128,
  maxFreeSockets: 64,
  scheduling: "lifo",
  timeout: 300000,
});

const HTTPS_UPSTREAM_AGENT = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 128,
  maxFreeSockets: 64,
  scheduling: "lifo",
  timeout: 300000,
});

function dohResolve(host: string, resolver = "cloudflare-dns.com"): Promise<string | null> {
  return new Promise((resolve) => {
    const url = `https://${resolver}/dns-query?name=${encodeURIComponent(host)}&type=A`;
    const req = httpsRequest(url, {
      method: "GET",
      headers: { Accept: "application/dns-json" },
      timeout: 5000,
      rejectUnauthorized: false,
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const answer = json.Answer?.find((a: any) => a.type === 1)?.data;
          if (answer && typeof answer === "string") {
            resolve(answer);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getRealIp(host: string): Promise<string> {
  if (realIps.has(host)) return realIps.get(host)!;
  // Try DNS-over-HTTPS first to avoid stale hardcoded fallback IPs
  try {
    const dohIp = await dohResolve(host);
    if (dohIp) {
      realIps.set(host, dohIp);
      log("DEBUG", `DoH resolved ${host} -> ${dohIp}`);
      return dohIp;
    }
  } catch {}
  // Fall back to hardcoded map
  if (REAL_IPS[host]) {
    realIps.set(host, REAL_IPS[host]);
    log("DEBUG", `Using hardcoded IP for ${host}: ${REAL_IPS[host]}`);
    return REAL_IPS[host];
  }
  log("DEBUG", `No real IP for ${host}, using hostname as-is`);
  return host;
}

async function primeRealIpCache() {
  for (const host of INTERCEPTED_HOSTS) {
    if (host === "127.0.0.1") continue;
    try {
      const ip = await dohResolve(host);
      if (ip) realIps.set(host, ip);
    } catch {}
  }
}

// Configuration -- mode from launch args or gc2xy_MODE env (dynamic via setMode)

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
const modeLogStr = isProxy() ? "PROXY" : isHybrid() ? "hybrid" : "mock";
const now = new Date();
const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
const logFile = join(LOG_DIR, `traffic-${dateStr}-${modeLogStr}.log`);
const logStream = createWriteStream(logFile, { flags: "a" });
let requestCounter = 0;
let cacheHitCount = 0;
let lastAgentName = "";

function trafficLogEnabled(): boolean {
  return _trafficLoggingEnabled;
}

function debugLog(msg: string) {
  const iso = new Date().toISOString();
  splitConsole.debugLog(generalLogLine("DEBUG", msg));
  if (trafficLogEnabled()) logStream.write(JSON.stringify({ timestamp: iso, level: "DEBUG", msg }) + "\n");
}

function log(level: string, msg: string, data: Record<string, any> = {}) {
  const iso = new Date().toISOString();
  if (level === "DEBUG") {
    splitConsole.debugLog(generalLogLine(level, msg));
  } else {
    console.log(generalLogLine(level, msg));
  }
  if (trafficLogEnabled()) logStream.write(JSON.stringify({ timestamp: iso, level, msg, ...data }) + "\n");
}

function logPlainEnglish(reqNum: number, direction: "REQUEST" | "RESPONSE", method: string, url: string, host: string, statusCode: number | null, headers: Record<string, string>, body: string | null, agentOverride?: string) {
  const agent = agentOverride || agentTag(headers);
  const dir = direction === "REQUEST" ? "REQ" : "RES";

  const _ev = headers["editor-version"] || "";
  const isDebugLine = _ev.startsWith("VS/VisualStudio") || _ev.startsWith("VS/SSMS") ||
    (agentOverride || "").includes("VS") || agent.includes("VS") || agent.includes("TEAM") || agent.includes("APP") || agent.includes("GO-HT") ||
    url.includes("/telemetry") || url.includes("/agents/sessions/") || url === "/" || url === "/favicon.ico" ||
    headers["x-gc2xy-test"] === "1";
  if (isDebugLine) {
    splitConsole.debugLog(httpLogLine(dir, method, url, statusCode, agent));
  } else {
    console.log(httpLogLine(dir, method, url, statusCode, agent));
  }

  if (!trafficLogEnabled()) return;

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
      mode: getMode().toUpperCase(),
      requests: reqNum,
      port: IIS_PROXY ? `443 → ${HTTP_PORT}` : (INTERCEPT_MODE === "hosts" ? 443 : PROXY_PORT),
      target: TARGET_HOST,
      cacheHits: cacheHitCount,
      PROXY: isProxy(),
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

  // IIS mode: bind our intercept cert to http.sys port 443
  if (IIS_PROXY) {
    try {
      const certInfo = getInterceptCert();
      const cert = forge.pki.certificateFromPem(certInfo.cert.toString());

      // Export to PFX with cert + key (no CA chain — netsh binding needs clean PFX)
      const pfxPath = join(CERT_DIR, "intercept.pfx");
      const key = forge.pki.privateKeyFromPem(certInfo.key.toString());
      const p12Asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], "", { algorithm: "3des" });
      writeFileSync(pfxPath, Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary"));

      // Remove any old CNG/KSP-backed MITM Proxy certs (incompatible with netsh)
      // Use subject match since thumbprint may differ between forge and Windows
      const delOld = spawnSync("powershell", ["-NoProfile", "-Command",
        "Get-ChildItem Cert:\\LocalMachine\\My | Where-Object {$_.Subject -eq 'CN=MITM Proxy' -and $_.PrivateKey -eq $null} | Remove-Item -Force"
      ], { stdio: "ignore", timeout: 10000 });

      // Import PFX to LocalMachine\My via certutil (uses legacy CSP, compatible with netsh/http.sys)
      // PowerShell X509KeyStorageFlags=0 stores key via CNG/KSP which netsh cannot bind (Error 1312)
      const certUtilImport = spawnSync("certutil", ["-f", "-p", "", "-importpfx", "MY", pfxPath], { encoding: "utf8", timeout: 15000 });
      const cuOut = (certUtilImport.stdout || "").trim();
      log("INFO", `certutil import: status=${certUtilImport.status} ${cuOut}`);
      if (certUtilImport.status !== 0) {
        // Fallback: PowerShell with MachineKeySet|PersistKeySet for legacy CSP
        const psImport = `$pfx=[IO.File]::ReadAllBytes('${pfxPath.replace(/\\/g, "\\\\")}');` +
          `$flags=[System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]'MachineKeySet,PersistKeySet';` +
          `$p=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfx,'',$flags);` +
          `$s=New-Object System.Security.Cryptography.X509Certificates.X509Store('My','LocalMachine');` +
          `$s.Open('ReadWrite');$s.Add($p);$s.Close();Write-Host "imported $($p.Thumbprint)"`;
        const imp = spawnSync("powershell", ["-NoProfile", "-Command", psImport], { encoding: "utf8", timeout: 15000 });
        const impOut = (imp.stdout || "").trim();
        log("INFO", `PS import: status=${imp.status} ${impOut}`);
      }

      // Read the ACTUAL thumbprint from Windows cert store after import
      // (forge-computed thumbprint may differ from Windows due to DER encoding differences)
      const getThumb = spawnSync("powershell", ["-NoProfile", "-Command",
        "Get-ChildItem Cert:\\LocalMachine\\My | Where-Object {$_.Subject -eq 'CN=MITM Proxy' -and $_.HasPrivateKey} | Select-Object -First 1 -ExpandProperty Thumbprint"
      ], { encoding: "utf8", timeout: 10000 });
      const thumbprint = (getThumb.stdout || "").trim().toUpperCase();
      if (!thumbprint || thumbprint.length < 20) {
        throw new Error(`Cannot read MITM cert thumbprint from store: '${thumbprint}'`);
      }
      log("INFO", `Intercept cert thumbprint (from store): ${thumbprint}`);

      // SNI-based bindings per intercepted host (only our hostnames get the MITM cert)
      // Never use ipport=0.0.0.0:443 — that poisons other IIS sites sharing port 443
      const interceptedHosts = ["github.com", "www.github.com", "api.github.com", "api.githubcopilot.com",
        "copilot-proxy.githubusercontent.com", "api.individual.githubcopilot.com",
        "origin-tracker.individual.githubcopilot.com", "proxy.individual.githubcopilot.com",
        "telemetry.individual.githubcopilot.com", "dc.services.visualstudio.com"];
      let bindOk = 0;
      for (const h of interceptedHosts) {
        spawnSync("netsh", ["http", "delete", "sslcert", `hostnameport=${h}:443`], { stdio: "ignore", timeout: 3000 });
        const r = spawnSync("netsh", ["http", "add", "sslcert", `hostnameport=${h}:443`, `certhash=${thumbprint}`, "certstorename=MY", "appid={4dc3e181-e14b-4a21-b022-59fc669b0914}"], { encoding: "utf8", timeout: 10000 });
        if (r.status === 0) bindOk++;
        else log("WARN", `netsh ${h}:443: ${(r.stderr || r.stdout || "").trim()}`);
      }
      log("INFO", `SNI bindings: ${bindOk}/${interceptedHosts.length} OK`);

      // Verify binding
      const verify = spawnSync("netsh", ["http", "show", "sslcert"], { encoding: "utf8", timeout: 5000 });
      const hasBind = (verify.stdout || "").toLowerCase().includes(thumbprint.toLowerCase());
      log("INFO", `Binding verified: ${hasBind ? "YES" : "NO - binding not found!"}`);
    } catch (e) {
      log("WARN", `IIS cert binding error: ${(e as Error).message}`);
    }
  }
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

// Serialize response headers, emitting one line per value for array headers
// (Set-Cookie comes from Node as string[] and must NOT be joined with commas —
// expires=... values contain commas, which corrupts the header.)
function serializeHeaders(headers: Record<string, any>, skip?: string[]): string {
  let out = "";
  const skipSet = skip ? new Set(skip.map(s => s.toLowerCase())) : null;
  for (const [key, value] of Object.entries(headers)) {
    if (skipSet && skipSet.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const v of value) out += `${key}: ${v}\r\n`;
    } else if (value !== undefined && value !== null) {
      out += `${key}: ${value}\r\n`;
    }
  }
  return out;
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

// Dashboard + device login interceptor chain
addRequestInterceptor(async (req) => {
  if (req.response) return;
  try {
    const handlerInput: HandlerInput = {
      method: req.method, url: req.url, headers: req.headers, body: req.body,
      hostname: req.hostname, port: req.port, clientSocket: req.clientSocket,
    };

    const urlPath = req.url.split("?")[0];
    // Dashboard/API routes — loopback only
    const remoteAddr = req.clientSocket?.remoteAddress || "";
    const isLoopback = remoteAddr.startsWith("127.") || remoteAddr.startsWith("::1") || remoteAddr === "::ffff:127.0.0.1";
    const isDashboardPath = urlPath === "/dashboard" || urlPath === "/health" || urlPath.startsWith("/api/");
    if (isLoopback && isDashboardPath) {
      const dashResult = await handleDashboard(handlerInput);
      if (dashResult.handled && dashResult.response) {
        dashIncReq();
        if (dashResult.response._streamed) {
          req._responseSent = true;
        } else {
          req.response = {
            statusCode: dashResult.response.statusCode,
            statusMessage: dashResult.response.statusMessage || "OK",
            headers: dashResult.response.headers,
            body: dashResult.response.body,
          };
        }
        return;
      }
    }

    if (!isProxy()) {
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
    } else {
      // Proxy mode: intercept VS 2022 (17.x) requests when a VS legacy model is
      // configured. VS 2022 uses an older API flow that real GitHub doesn't
      // support (GetNewAutoModelAsync → /models/session → 400 text/plain).
      //
      // Also intercept GitHub Desktop App (github-app/*) and GitHub Copilot
      // Desktop (undici) Copilot API endpoints. The upstream /copilot_internal
      // token call can hang, blocking model loading. By intercepting Copilot
      // API endpoints (token, models, chat) we return fake responses
      // immediately — models load and chat requests forward to the configured
      // LLM provider. OAuth, /user, /repos, etc. still pass through to real
      // GitHub with the real OAuth token.
      const legacyModel = getVsLegacyModel();
      const ua = (req.headers["user-agent"] || "").toLowerCase();
      const isGHCP = ua.startsWith("github-app/");
      const isDesktop = ua.includes("undici");
      const isVS = isVSShell(req.headers);
      const isGhCli = ua.includes("github cli");
      const copilotApiPath =
        req.url.startsWith("/copilot_internal/") ||
        req.url.startsWith("/models") || req.url.startsWith("/v1/models") ||
        req.url.startsWith("/v1/chat/") || req.url.startsWith("/v1/messages") ||
        req.url.startsWith("/v1/embeddings") || req.url.startsWith("/v1/tokenize") ||
        req.url.startsWith("/completions") || req.url.startsWith("/responses") ||
        req.url.startsWith("/agents/") || req.url.startsWith("/mcp");
      // GitHub App needs Copilot API paths plus GHCP-specific paths (e.g.
      // autopilot team membership) that real GitHub returns 404 for.
      const ghcpSpecificPath = isGHCP && (
        req.url.startsWith("/orgs/github/teams/autopilot/memberships/") ||
        req.url.includes("/github/app/discussions") ||
        req.url.includes("/github/github-app/discussions")
      );
      const ghcpCopilotPath = isGHCP && (copilotApiPath || ghcpSpecificPath);
      // For Copilot Desktop we intercept both Copilot API paths and all auth
      // endpoints so the dedicated desktop handler can serve fake auth/token
      // responses while still logging the traffic.
      const desktopAuthPath = isDesktop && (
        req.url.startsWith("/login/") ||
        req.url.startsWith("/user") ||
        req.url.startsWith("/copilot_internal/") ||
        copilotApiPath
      );
      // VS-family (Visual Studio + VS Team Explorer) auth/copilot endpoints
      // must be intercepted so enterprise plan responses are returned; real
      // GitHub rejects tokens that don't have Copilot entitlement.
      const vsCopilotPath = isVS && (copilotApiPath || req.url.startsWith("/login/") || req.url.startsWith("/user"));
      // GitHub CLI (gh) subprocess spawned by the GitHub Copilot desktop app.
      // It uses GH_TOKEN (fake in hybrid/mock) which real GitHub rejects, so
      // intercept its auth/copilot/model calls and serve fake responses.
      const ghCliPath = isGhCli && (
        req.url.startsWith("/user") ||
        req.url.startsWith("/copilot_internal/") ||
        req.url.startsWith("/models") || req.url.startsWith("/v1/models") ||
        req.url.startsWith("/login/") ||
        copilotApiPath
      );
      // VS Code OAuth flow happens in the browser (Chrome UA) — the URL
      // carries VS Code Copilot signals (client_id=01ab8ac9400c4e429b23,
      // get_started_with=copilot-vscode, redirect_uri=vscode.dev/redirect).
      // VS Code's own token exchange POST has UA "Visual Studio Code".
      // Intercept both so the fake account picker + fake token flow runs
      // instead of forwarding to real GitHub with real session cookies.
      const isVscodeClient = ua.includes("visual studio code");
      const hasVscodeOAuthSignal =
        req.url.includes("client_id=01ab8ac9400c4e429b23") ||
        req.url.includes("get_started_with=copilot-vscode") ||
        req.url.includes("redirect_uri=https%3A%2F%2Fvscode.dev%2Fredirect");
      const vscodeOAuthPath = (req.url.startsWith("/login/oauth/") || req.url.startsWith("/login/device")) &&
        (hasVscodeOAuthSignal || isVscodeClient);
      if ((legacyModel && isVSLegacyClient(req.headers)) || ghcpCopilotPath || desktopAuthPath || vsCopilotPath || ghCliPath || vscodeOAuthPath) {
        if (desktopAuthPath) console.log(`[PROXY MODE] Intercepting Copilot Desktop request: ${req.method} ${req.url}`);
        if (ghcpSpecificPath) console.log(`[PROXY MODE] Intercepting GitHub App request: ${req.method} ${req.url}`);
        if (vsCopilotPath) console.log(`[PROXY MODE] Intercepting VS-family request: ${req.method} ${req.url}`);
        if (ghCliPath) console.log(`[PROXY MODE] Intercepting gh CLI request: ${req.method} ${req.url}`);
        if (vscodeOAuthPath) console.log(`[PROXY MODE] Intercepting VS Code OAuth request: ${req.method} ${req.url}`);
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
  const _whitelisted = ["Visual Studio", "SSMS", "GitHub Copilot Desktop"]; // agents worth showing in status bar
  if (_whitelisted.some(w => _newAgent.startsWith(w))) lastAgentName = _newAgent;

  const editorVer = headers["editor-version"] || "";
  if (editorVer.startsWith("VS/VisualStudio") || editorVer.startsWith("VS/SSMS")) {
    const baggage = headers["baggage"] || "";
    const initiator = headers["x-initiator"] || "";
    const initType = baggage.match(/vs\.copilot\.InteractionType\s*=\s*(\S+)/)?.[1] || "";
    const initBy = baggage.match(/vs\.copilot\.InitiatorType\s*=\s*(\S+)/)?.[1] || "";
    const _vsMsg = `[VS DETECTED] ${method} ${url} � editor: ${editorVer} | initiator=${initiator} | mode=${initType} | by=${initBy}`;
    const iso = new Date().toISOString();
    if (trafficLogEnabled()) logStream.write(JSON.stringify({ timestamp: iso, level: "INFO", msg: _vsMsg }) + "\n");
    if (isDebug()) console.log(generalLogLine("INFO", _vsMsg));
  }

  // The unified intercept cert covers all intercepted hosts, so SNI is not
  // reliable for routing. Prefer the HTTP Host header (which the client set
  // based on the URL it requested) so api.github.com/user/orgs routes to
  // api.github.com and not the default github.com.
  const httpHost = (headers["host"] || "").split(":")[0].toLowerCase();
  const targetHost = httpHost || host;
  let interceptedReq: InterceptedRequest = {
    method, url, headers: { ...headers }, body: reqBody, hostname: targetHost, port, blocked: false,
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
    const ctVal = Object.entries(resHeaders).find(([k]) => k.toLowerCase() === "content-type")?.[1];
    if (typeof ctVal === "string" && ctVal.includes("text/event-stream")) isSSE = true;
    respHeader += serializeHeaders(resHeaders, ["transfer-encoding", "connection", "keep-alive", "content-length"]);
    if (isSSE) {
      respHeader += `Content-Length: ${resBody.length}\r\nConnection: close\r\n\r\n`;
      client.write(respHeader);
      if (resBody.length > 0) client.write(resBody);
      client.end();
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
      respHeader += serializeHeaders(replayed.headers, ["transfer-encoding", "connection", "keep-alive", "content-length"]);
      respHeader += `Content-Length: ${respBody.length}\r\nConnection: close\r\n\r\n`;
      client.write(respHeader);
      if (respBody.length > 0) client.write(respBody);
      client.end();
      return;
    }
  }

  const useHttps = finalPort === 443;
  const upstreamHost = await getRealIp(finalHost);
  let streamingStarted = false;
  const req = (useHttps ? httpsRequest : httpRequest)({
    hostname: upstreamHost, port: finalPort, path: finalUrl, method: finalMethod,
    headers: { ...finalHeaders, host: finalHost },
    rejectUnauthorized: false,
    agent: (useHttps ? HTTPS_UPSTREAM_AGENT : HTTP_UPSTREAM_AGENT) as any,
  }, async (res) => {
    const ctVal = (res.headers as Record<string, string>)["content-type"] || "";
    if (ctVal.includes("text/event-stream")) {
      streamingStarted = true;
      const statusCode = res.statusCode || 200;
      const statusMessage = res.statusMessage || "OK";
      const sseHeaders = { ...res.headers as Record<string, string> };
      let respHeader = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
      respHeader += serializeHeaders(sseHeaders, ["transfer-encoding", "connection", "keep-alive", "content-length"]);
      respHeader += `Connection: close\r\n\r\n`;
      client.write(respHeader);

      let sseLen = 0;
      res.on("data", (chunk: Buffer) => {
        try {
          const ok = client.write(chunk);
          sseLen += chunk.length;
          if (!ok) res.pause();
        } catch {}
      });
      client.on("drain", () => { try { res.resume(); } catch {} });
      res.on("end", () => {
        try { client.end(); } catch {}
        logPlainEnglish(reqNum, "RESPONSE", finalMethod, finalUrl, finalHost, statusCode, sseHeaders, `(streamed ${sseLen}B)`, agentTag(finalHeaders));
        if (recorder.isRecording) {
          recorder.recordEntry(
            { method: finalMethod, url: finalUrl, headers: finalHeaders, body: finalBody?.toString() ?? null },
            { statusCode, statusMessage, headers: sseHeaders, body: "(streamed)" },
          );
        }
      });
      res.on("error", (err: Error) => {
        log("ERROR", `SSE stream error: ${err.message}`);
        try { client.end(); } catch {}
      });
      return;
    }

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
            json.mitm_mode = getMode();
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
      respHeader += serializeHeaders(resHeaders, ["transfer-encoding", "connection", "keep-alive", "content-length"]);
      if (responseBody.length > 0) {
        respHeader += `Content-Length: ${responseBody.length}\r\n`;
      }
      respHeader += `Connection: close\r\n\r\n`;

      client.write(respHeader);
      if (responseBody.length > 0) client.write(responseBody);
      client.end();
    });
    res.on("error", (err: Error) => {
      log("ERROR", `Upstream response error: ${err.message}`);
      try { client.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 11\r\nConnection: close\r\n\r\nBad Gateway\r\n"); } catch {}
      try { client.end(); } catch {}
    });
  });

  req.on("error", (err: Error) => {
    log("ERROR", `Upstream error: ${err.message}`);
    if (!streamingStarted) {
      try { client.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 11\r\nConnection: close\r\n\r\nBad Gateway\r\n"); } catch {}
    }
    try { client.end(); } catch {}
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
        const headerStr = buffer.toString("utf-8");
        const headerEnd = headerStr.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const firstLine = headerStr.split("\r\n")[0];

        const parsed = parseHttpRequest(buffer);
        if (!parsed || requestHandled) return;

        // WebSocket upgrade
        if (parsed.url === "/ws" && parsed.headers["upgrade"]?.toLowerCase() === "websocket") {
          requestHandled = true;
          // Check if this is a Visual Studio sync WS connection
          const editorVersion = (parsed.headers["editor-version"] || "").toLowerCase();
          const isVS = editorVersion.startsWith("vs/visualstudio") || editorVersion.startsWith("vs/ssms") || /^vs\/\d/.test(editorVersion);
          if (isVS) {
            // Accept VS WebSocket and keep alive with ping frames
            const key = parsed.headers["sec-websocket-key"] || "";
            if (key) {
              const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
              tlsSocket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
              const pingInterval = setInterval(() => {
                try { if (!tlsSocket.destroyed) tlsSocket.write(Buffer.from([0x89, 0x00])); } catch {}
              }, 30000);
              tlsSocket.on("close", () => clearInterval(pingInterval));
              tlsSocket.on("error", () => clearInterval(pingInterval));
            }
          } else {
            // Pipe to dashboard WS server
            const wsPort = parseInt(process.env.gc2xy_WS_PORT || "3441");
            try {
              const upstream = createConnection(wsPort, "127.0.0.1", () => {
                upstream.write(buffer);
                tlsSocket.pipe(upstream);
                upstream.pipe(tlsSocket);
              });
              upstream.on("error", () => { try { tlsSocket.end(); } catch {} });
              tlsSocket.on("error", () => { try { upstream.end(); } catch {} });
            } catch (e) {
              if (!tlsSocket.destroyed) tlsSocket.end();
            }
          }
          return;
        }

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

      tlsSocket.on("error", (err: Error) => {
        // ECONNRESET / EPIPE / ECONNABORTED after a response was already sent
        // are normal HTTP/1.1 keep-alive cleanup (client navigated away, idle
        // socket closed, etc.) — demote to DEBUG so the console doesn't get
        // spammed with red ERROR lines that aren't actually errors.
        const benign = ["ECONNRESET", "EPIPE", "ECONNABORTED"];
        const level = requestHandled && benign.some(b => err.message.includes(b)) ? "DEBUG" : "ERROR";
        log(level, `TLS error for ${host}: ${err.message}`);
      });
    });

    httpsServer.on("tlsClientError", (err: Error) => {
      // Same demotion: most tlsClientError events are pre-handshake
      // client-side aborts (browser cancelled navigation, scanner probing).
      const benign = ["ECONNRESET", "EPIPE", "ECONNABORTED"];
      const level = benign.some(b => err.message.includes(b)) ? "DEBUG" : "ERROR";
      log(level, `TLS client error: ${err.message}`);
    });

    killPortProcess(HTTPS_PORT);
    httpsServer.listen(HTTPS_PORT, "127.0.0.1", () => {
      log("INFO", `HTTPS intercept server on 127.0.0.1:${HTTPS_PORT}`);
    });
    httpsServer.on("error", (err: Error) => {
      log("ERROR", `Failed to bind HTTPS port ${HTTPS_PORT}: ${err.message}. Another process may be using it.`);
    });
    servers.push(httpsServer);
  }

  // HTTP server (always created — IIS reverse proxy uses this)
  const httpServer = createServer();
  httpServer.on("connection", (clientSocket: Socket) => {
    let buffer = Buffer.alloc(0);
    let requestHandled = false;

    clientSocket.on("data", (data: Buffer) => {
      if (requestHandled) return;
      buffer = Buffer.concat([buffer, data]);

      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headerStr = buffer.slice(0, headerEnd).toString("utf-8");
      const full = headerStr.toLowerCase();
      if (full.includes("upgrade: websocket")) {
        requestHandled = true;
        const raw = buffer.toString("utf-8");
        const editorVersionMatch = raw.match(/editor-version:\s*([^\r\n]+)/i);
        const editorVersion = editorVersionMatch ? editorVersionMatch[1].toLowerCase() : "";
        const isVS = editorVersion.startsWith("vs/visualstudio") || editorVersion.startsWith("vs/ssms") || /^vs\/\d/.test(editorVersion);
        if (isVS) {
          const keyMatch = raw.match(/sec-websocket-key:\s*([^\r\n]+)/i);
          const key = keyMatch ? keyMatch[1].trim() : "";
          if (key) {
            const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
            clientSocket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
            const pingInterval = setInterval(() => {
              try { if (!clientSocket.destroyed) clientSocket.write(Buffer.from([0x89, 0x00])); } catch {}
            }, 30000);
            clientSocket.on("close", () => clearInterval(pingInterval));
            clientSocket.on("error", () => clearInterval(pingInterval));
          }
        } else {
          const wsPort = parseInt(process.env.gc2xy_WS_PORT || "3441");
          const upstream = createConnection(wsPort, "127.0.0.1", () => {
            upstream.write(buffer);
            clientSocket.pipe(upstream);
            upstream.pipe(clientSocket);
          });
          upstream.on("error", () => clientSocket.end());
          clientSocket.on("error", () => upstream.end());
        }
        return;
      }

      const parsed = parseHttpRequest(buffer);
      if (!parsed) return;

      // Wait for the full body (Content-Length) before processing — prevents
      // truncated POST bodies when the body is split across TCP packets,
      // which caused 503s on /login/oauth/access_token and chat completions.
      const contentLen = parseInt(parsed.headers["content-length"] || "0", 10);
      const bodyBytes = buffer.length - parsed.bodyOffset;
      if (contentLen > 0 && bodyBytes < contentLen) {
        if (parsed.headers["expect"]?.toLowerCase() === "100-continue") {
          clientSocket.write("HTTP/1.1 100 Continue\r\n\r\n");
        }
        return;
      }

      requestHandled = true;
      handlePlainHttpRequest(clientSocket, buffer, IIS_PROXY ? HTTP_PORT : 80).catch((e) => log("ERROR", `HTTP handler error: ${e.message}`));
    });
  });

  killPortProcess(HTTP_PORT);
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

  killPortProcess(PROXY_PORT);
  proxyServer.listen(PROXY_PORT, "127.0.0.1", () => {
    log("INFO", `Proxy server on 127.0.0.1:${PROXY_PORT}`);
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

  tlsSocket.on("error", (err: Error) => {
    // See note in createInterceptServers — benign close-after-response errors
    // should not pollute the log with red ERROR lines.
    const benign = ["ECONNRESET", "EPIPE", "ECONNABORTED"];
    const level = benign.some(b => err.message.includes(b)) ? "DEBUG" : "ERROR";
    log(level, `TLS error for ${host}: ${err.message}`);
  });
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

  // Mock GHCP app IPC endpoints (used for browser preview lifecycle)
  if (host === "ipc.localhost") {
    const body = JSON.stringify({ success: true, mock: "gc2xy" });
    const resp = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    clientSocket.write(resp);
    clientSocket.end();
    return;
  }

  const headers: Record<string, string> = {};
  const preservedProto = allHeaders["x-forwarded-proto"];
  for (const [key, value] of Object.entries(allHeaders)) {
    if (!["host", "proxy-connection", "connection", "x-forwarded-for", "x-arr-log-id", "x-arr-clientcert", "x-original-url"].includes(key)) {
      headers[key] = value;
    }
  }

  const contentLen = parseInt(allHeaders["content-length"] || "0", 10);
  const body = contentLen > 0 && bodyOffset + contentLen <= data.length
    ? data.slice(bodyOffset, bodyOffset + contentLen)
    : null;

  // Dashboard route — always intercepted (even in proxy mode), loopback only
  const remoteAddr = clientSocket.remoteAddress || "";
  const isLoopback = remoteAddr.startsWith("127.") || remoteAddr.startsWith("::1") || remoteAddr === "::ffff:127.0.0.1";
  const isDashboardPath = url === "/dashboard" || url.startsWith("/dashboard?") || url === "/health" || url.startsWith("/api/");
  if (isLoopback && isDashboardPath) {
    try {
      const dashReq = { method, url, headers, body, hostname: host, port, clientSocket: clientSocket as any };
      const result = await handleDashboard(dashReq);
      if (result.handled && result.response) {
        dashIncReq();
        const { statusCode, statusMessage, headers: respHeaders, body: respBody } = result.response;
        let resp = `HTTP/1.1 ${statusCode} ${statusMessage || "OK"}\r\n`;
        resp += serializeHeaders(respHeaders, ["connection", "content-length", "transfer-encoding", "keep-alive"]);
        resp += `Connection: close\r\nContent-Length: ${respBody.length}\r\n\r\n`;
        clientSocket.write(resp);
        clientSocket.write(respBody);
        clientSocket.end();
        return;
      }
    } catch (e) {
      log("ERROR", `Dashboard handler error: ${(e as Error).message || e}`);
    }
  }

  // Run interceptor chain (same as TLS path)
  try {
    const interceptedReq: InterceptedRequest = {
      method, url, headers, body, hostname: host, port,
      blocked: false, clientSocket: clientSocket as any,
    };
    await runRequestInterceptors(interceptedReq);
    if ((interceptedReq as any)._responseSent) {
      return;
    }
    if (interceptedReq.response && !(interceptedReq as any)._responseSent) {
      const { statusCode, statusMessage, headers: respHeaders, body: respBody } = interceptedReq.response;
      let resp = `HTTP/1.1 ${statusCode} ${statusMessage || "OK"}\r\n`;
      resp += serializeHeaders(respHeaders, ["connection", "content-length", "transfer-encoding", "keep-alive"]);
      resp += `Connection: close\r\nContent-Length: ${respBody.length}\r\n\r\n`;
      clientSocket.write(resp);
      clientSocket.write(respBody);
      clientSocket.end();
      return;
    }
  } catch (e) {
    log("ERROR", `Fake handler (HTTP): ${(e as Error).message || e}`);
  }

  const useHttps = IIS_PROXY
    ? true
    : (port === 443 || port === PROXY_PORT);
  const targetPort = useHttps ? 443 : 80;
  const upstreamHost = await getRealIp(host);

  const upstreamHeaders = { ...headers, host };
  delete upstreamHeaders["x-forwarded-proto"];
  const req = (useHttps ? httpsRequest : httpRequest)({
    hostname: upstreamHost, port: targetPort, path: url, method,
    headers: upstreamHeaders,
    rejectUnauthorized: false,
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => {
      const body = Buffer.concat(chunks);
      logPlainEnglish(++requestCounter, "REQUEST", method, url, host, null, headers, body?.toString() ?? null);
      logPlainEnglish(requestCounter, "RESPONSE", method, url, host, res.statusCode || 0, res.headers, body.toString());
      let respHeader = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
      respHeader += serializeHeaders(res.headers as Record<string, any>, [
        "transfer-encoding", "connection", "keep-alive", "content-length",
      ]);
      respHeader += `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
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
  if (r.stdout?.trim()) { try { mkdirSync(join(getProjectRoot(), ".cache"), { recursive: true }); writeFileSync(join(getProjectRoot(), ".cache", "proxy-host-pid"), r.stdout.trim() + "\n", "utf-8"); } catch {} }
} catch {}

// Preload models at startup so the model list (?) is populated
addModels().catch(() => {});
splitConsole.drawStatusBar({
  mode: getMode().toUpperCase(),
  requests: 0,
  port: IIS_PROXY ? `443 → ${HTTP_PORT}` : (INTERCEPT_MODE === "hosts" ? 443 : PROXY_PORT),
  target: TARGET_HOST,
  cacheHits: 0,
  PROXY: isProxy(),
  lastAgent: "",
  tps: 0,
  runtime: runtimeTag,
});

// Wire up commands
splitConsole.onCommand((cmd: string) => {
  if (cmd === "stop") shutdown();
  else if (cmd === "restart") {
    // Persist current mode to config.json + restart-mode before exiting,
    // so the relaunched process reads the correct mode via --restart.
    setMode(getMode());
    splitConsole.restoreTerminal();
    for (const s of servers) s.close();
    logStream.end();
    try { unlinkSync(join(getProjectRoot(), ".cache", "proxy-host-pid")); } catch {}
    process.exit(42);
  } else if (cmd.startsWith("switch:")) {
    const targetMode = cmd.split(":")[1].toLowerCase();
    const validModes: Record<string, "mock" | "hybrid" | "proxy"> = { mock: "mock", hybrid: "hybrid", proxy: "proxy" };
    const newMode = validModes[targetMode] || "mock";
    setMode(newMode);
    log("INFO", `Switched to ${newMode.toUpperCase()} mode`);
    addModels().catch(() => {});
    splitConsole.drawStatusBar({
      mode: getMode().toUpperCase(),
      requests: requestCounter,
      port: IIS_PROXY ? `443 → ${HTTP_PORT}` : (INTERCEPT_MODE === "hosts" ? 443 : PROXY_PORT),
      target: TARGET_HOST,
      cacheHits: cacheHitCount,
      PROXY: isProxy(),
      lastAgent: lastAgentName,
      tps: getTps(),
      runtime: runtimeTag,
    });
  } else if (cmd === "record") {
    _trafficLoggingEnabled = true;
    recorder.startRecording().catch(() => {});
    splitConsole.setRecording(true);
  } else if (cmd === "stoprecord") {
    _trafficLoggingEnabled = false;
    if (recorder.isRecording) {
      recorder.stopRecordingAuto().then(() => splitConsole.setRecording(false)).catch(() => {});
    }
  } else if (cmd === "refresh") {
    log("INFO", "Refreshing model list...");
    addModels().catch(() => {});
  }
});

let servers: any[] = [];
createWsServer(); // Initialize WebSocket server for dashboard
// Patch SSMS Copilot MCP configs to READ_WRITE so the agent can execute CREATE/ALTER/etc.
// Controlled by .config/config.json `MCP_WRITE` field (default: true). Set MCP_WRITE=false to disable.
try { patchSsmsMcpConfigs((m: string) => log("INFO", m)); } catch (e: any) { log("ERROR", `MCP-WRITE failed: ${e?.message || e}`); }
if (INTERCEPT_MODE === "hosts") {
  setupHostsRedirect();
  servers = createInterceptServers();
} else {
  servers = [createProxyServer()];
}

log("DEBUG", `CA cert: ${CA_CERT_PATH}`);
log("READY", "Proxy ready — status bar above, live log below");
startWsPushLoop();
// Pre-resolve real GitHub IPs via DoH so upstream connections don't use stale fallbacks
primeRealIpCache().catch(() => {});

// Self-test: verify MITM interception works
setTimeout(() => {
  const mitmMode = getMode();
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
  try { unlinkSync(join(getProjectRoot(), ".cache", "proxy-host-pid")); } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

