import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getProjectRoot } from "./shared.ts";

const STORE_DIR = join(getProjectRoot(), ".cache");
mkdirSync(STORE_DIR, { recursive: true });

interface StoredResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  bodyData: string;
}

export function entryPath(method: string, url: string, host: string): string {
  const sanitized = `${method}_${host}${url}`
    .replace(/[<>:"\/\\|?*]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase()
    .slice(0, 200);
  return join(STORE_DIR, `${sanitized}.json`);
}

export function saveToStore(
  method: string,
  url: string,
  host: string,
  statusCode: number,
  statusMessage: string,
  headers: Record<string, string>,
  body: Buffer,
): void {
  try {
    const p = entryPath(method, url, host);
    const entry: StoredResponse = {
      statusCode,
      statusMessage,
      headers,
      bodyData: body.toString("base64"),
    };
    writeFileSync(p, JSON.stringify(entry));
  } catch {}
}

export function loadFromStore(method: string, url: string, host: string): StoredResponse | null {
  try {
    const p = entryPath(method, url, host);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function getStoreSize(): number {
  try {
    return readdirSync(STORE_DIR).filter(f => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
