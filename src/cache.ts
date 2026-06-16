import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getProjectRoot } from "./shared.ts";

const CACHE_DIR = join(getProjectRoot(), ".cache");
mkdirSync(CACHE_DIR, { recursive: true });

interface CachedResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  bodyBase64: string;
}

export function cachePath(method: string, url: string, host: string): string {
  const sanitized = `${method}_${host}${url}`
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase()
    .slice(0, 200);
  return join(CACHE_DIR, `${sanitized}.json`);
}

export function saveToCache(
  method: string,
  url: string,
  host: string,
  statusCode: number,
  statusMessage: string,
  headers: Record<string, string>,
  body: Buffer,
): void {
  try {
    const path = cachePath(method, url, host);
    const entry: CachedResponse = {
      statusCode,
      statusMessage,
      headers,
      bodyBase64: body.toString("base64"),
    };
    writeFileSync(path, JSON.stringify(entry));
  } catch {}
}

export function loadFromCache(method: string, url: string, host: string): CachedResponse | null {
  try {
    const path = cachePath(method, url, host);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function getCacheSize(): number {
  try {
    return readdirSync(CACHE_DIR).filter(f => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
