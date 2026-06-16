// Internationalization helpers for dashboard translation (UMANS-style autotranslation)
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getProjectRoot } from "./shared.ts";

export const I18N_STRINGS: Record<string, string> = {
  app_title: "gc2xy",
  status_checking: "Checking...",
  status_online: "Online",
  status_offline: "Offline",
  status_reconnecting: "Reconnecting...",

  label_mode: "Mode",
  label_lreq: "LReq",
  label_tps: "TPS",
  label_keys: "Keys",
  label_models: "Models",
  label_window: "Window",
  label_requests: "Requests",
  label_tokens: "Tokens",
  label_quota: "90 Days",
  label_account: "Account",

  section_models: "Models",
  section_proxy_config: "Proxy Config",
  section_github_settings: "GitHub Settings",
  section_quick_actions: "Quick Actions",
  section_environment: "Environment",
  section_keys: "Keys",

  header_models_manage: "Models are loaded automatically from active providers.",

  btn_manage: "Manage",
  btn_check_health: "Check Health",
  btn_refresh_models: "Refresh Models",
  btn_restart: "Restart",

  label_mode_select: "Mode",
  mode_mock: "Mock",
  mode_hybrid: "Hybrid",
  mode_proxy: "Proxy",

  label_providers: "Providers",
  provider_freebuff: "FREEBUFF",
  provider_agnes: "AGNES",
  provider_bitnet: "BITNET",
  provider_codestral: "CODESTRAL",
  provider_umans: "UMANS",

  label_agnes_key: "Agnes API Key",
  label_codestral_key: "Codestral API Key",
  key_status: "Key shown as",
  key_status_set: "set",
  key_status_not_set: "not set",

  label_sku_mode: "SKU Mode",
  label_fake_username: "Fake Username",
  label_fake_display_name: "Fake Display Name",

  label_user_id: "User ID",
  btn_copy_user_id: "Copy User ID",
  btn_login: "Login",
  btn_logout: "Logout",
  status_not_logged_in: "Not logged in",
  status_logged_in: "Logged in",

  modal_umans_account: "Manage Keys",
  modal_umans_login: "UMANS Login",
  umans_add_new_key: "Add New Key",
  umans_edit_key: "Edit Key",
  placeholder_key_name: "Key name",
  placeholder_umans_key: "UMANS API key (sk-...)",
  label_email: "Email",
  label_password: "Password",
  placeholder_email: "email@example.com",
  placeholder_password: "password",
  btn_save_and_login: "Save & Login",
  btn_add_key: "Add Key",
  btn_save: "Save",
  btn_delete: "Delete",
  btn_edit: "Edit",
  label_name: "Name",
  label_key: "Key",
  label_unnamed: "Unnamed",
  msg_no_umans_keys: "No UMANS API keys configured.",
  msg_key_required: "Key required",
  confirm_delete_key: "Delete this key?",
  label_enabled_models: "Enabled Models",
  msg_no_umans_models: "No UMANS models loaded.",

  label_supermaven: "Supermaven Code Completion",
  label_supermaven_fallback: "Fallback Model (when Supermaven unavailable)",
  supermaven_enable: "Use Supermaven for code completions",

  label_wallpaper: "Wallpaper",
  wp_none: "None",
  wp_bing: "Bing",
  wp_wallhaven: "Wallhaven",
  wp_ai: "AI (FreeGen)",
  wp_prompt: "AI (FreeGen) Prompt",
  wp_default: "Default",
  wp_save: "Generate",
  wp_generating: "Generating...",
  wp_status_generating: "Generating via FreeGen (this may take ~10-30s)...",
  toast_freegen_applied: "FreeGen wallpaper generated!",
  toast_freegen_failed: "FreeGen generation failed: {error}",

  label_working_directory: "Working Directory",
  label_runtime: "Runtime",
  label_port: "Port",
  label_started_at: "Started At",
  label_platform: "Platform",
  env_ss_mode: "SS Mode",
  ss_mode_on: "On",
  ss_mode_off: "Off",

  section_test_chat: "Test Chat",
  test_chat_ctx: "Ctx",
  test_chat_stream: "Stream",
  test_chat_clear_title: "Clear conversation",
  test_chat_empty: "Select a model and ask anything to test.",
  test_chat_placeholder: "Type a message...",
  test_chat_send: "Send",
  test_chat_you: "You",
  test_chat_error: "Error",

  autotranslate_label: "AUTOTRANSLATION",
  forced_locale_hint: "(forced: {locale})",
  overlay_translating: "Translating",
  overlay_translating_sub: "Translating UI to {lang}...",
  btn_cancel: "Cancel",

  toast_translation_failed: "Translation failed: {error}",
  toast_health_failed: "Health check failed",
  toast_models_refreshed: "Models refreshed",
  toast_key_added: "Key added",
  toast_key_updated: "Key updated",
  toast_key_deleted: "Key deleted",
  toast_login_success: "Login successful",
  toast_login_failed: "Login failed",
  toast_logout_success: "Logged out",
  toast_logout_failed: "Logout failed",
  toast_wallpaper_applied: "Wallpaper applied.",
  toast_wallpaper_error: "Wallpaper error: {error}",
  toast_copied: "Copied!",
  toast_saved: "Saved",
};

function getI18nCacheDir(): string {
  const d = join(getProjectRoot(), ".cache", "i18n");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function getI18nCachePath(locale: string): string {
  return join(getI18nCacheDir(), `${locale}.json`);
}

export function loadI18nCache(locale: string): { locale: string; source: string; generated_at: string | null; strings: Record<string, string> } | null {
  const fp = getI18nCachePath(locale);
  if (!existsSync(fp)) return null;
  try { return JSON.parse(readFileSync(fp, "utf-8")); }
  catch { return null; }
}

function saveI18nCache(locale: string, data: any) {
  const fp = getI18nCachePath(locale);
  const dir = join(fp, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(fp, JSON.stringify(data, null, 2));
}

function splitI18nBatches<T>(items: T[], batchSize: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

function parseI18nBatchResponse(text: string, expectedKeys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const byIdx = new Map<number, string>();
  for (const ln of text.split(/\r?\n/)) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf("|");
    if (sepIdx <= 0) continue;
    const numStr = trimmed.slice(0, sepIdx).replace(/[^0-9]/g, "");
    if (!numStr) continue;
    const idx = parseInt(numStr, 10);
    if (Number.isNaN(idx) || idx < 1) continue;
    let value = trimmed.slice(sepIdx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value) byIdx.set(idx, value);
  }
  for (let i = 0; i < expectedKeys.length; i++) {
    const key = expectedKeys[i];
    if (byIdx.has(i + 1)) result[key] = byIdx.get(i + 1)!;
    else result[key] = I18N_STRINGS[key];
  }
  return result;
}

function buildTranslatePrompt(locale: string, localeNative: string, entries: [string, string][]): string {
  const lines = entries.map(([key, value], i) => `${i + 1}|${value}`).join("\n");
  return `You are translating UI strings of a software dashboard to ${localeNative}.

For each numbered line, output the translation in EXACTLY this format:
NUMBER|TRANSLATION

Rules:
- Keep ALL placeholders exactly as written: {model}, {name}, {time}, {user}, {email}, {n}, {p}, {m}, {lang}, {locale}, {error}
- Keep product names (gc2xy, UMANS, FreeGen, Agnes) and technical terms (API, URL, HTTP, SKU, SS Mode) untranslated where idiomatic
- Keep short labels concise (button labels = 1-2 words in target language)
- Preserve capitalization style of the source
- Do NOT add numbering, commentary, or extra lines
- Output one line per input line, in the same order, from 1 to ${entries.length}
- Translate ALL ${entries.length} lines, even if some are similar

Input:\n${lines}`;
}

const I18N_TRANSLATE_MAX_RETRIES = 3;
const I18N_TRANSLATE_RETRY_DELAY_MS = 5000;

function isRetryableTranslateError(err: any): boolean {
  const msg = err?.message || String(err);
  if (/upstream 5\d\d/i.test(msg)) return true;
  if (/upstream 429/i.test(msg)) return true;
  if (/fetch failed|aborted|network|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)) return true;
  return false;
}

let _umansTranslationApiKey = "";

export function setUmansTranslationApiKey(key: string): void {
  _umansTranslationApiKey = key || "";
}

export function getUmansTranslationKey(): string {
  return _umansTranslationApiKey;
}

async function callUmansFlashTranslate(promptText: string, key: string): Promise<string> {
  const body = JSON.stringify({
    model: "umans-flash",
    messages: [
      { role: "system", content: "You are a precise UI translator. Translate each numbered line into the requested target language. Preserve placeholders like {model}, {name}, {time}, {user}, {email}, {n}, {p}, {m}, {lang}, {locale}, {error} exactly. Keep short labels concise. Output one translation per line in the format NUMBER|TRANSLATION and nothing else." },
      { role: "user", content: promptText },
    ],
    temperature: 0.2,
    stream: false,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch("https://api.code.umans.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Accept": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`upstream ${resp.status}: ${errText}`);
    }
    const data: any = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") throw new Error("no translation content returned");
    return content;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function callUmansFlashTranslateWithRetry(promptText: string, key: string): Promise<string> {
  let lastErr: any;
  for (let attempt = 1; attempt <= I18N_TRANSLATE_MAX_RETRIES; attempt++) {
    try {
      return await callUmansFlashTranslate(promptText, key);
    } catch (e) {
      lastErr = e;
      const msg = (e as Error)?.message || String(e);
      if (!isRetryableTranslateError(e) || attempt === I18N_TRANSLATE_MAX_RETRIES) throw e;
      const delay = I18N_TRANSLATE_RETRY_DELAY_MS * attempt;
      console.log(`[i18n] Translate attempt ${attempt}/${I18N_TRANSLATE_MAX_RETRIES} failed (${msg.slice(0, 160)}), retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function translateCatalogForLocale(locale: string, localeNative: string): Promise<Record<string, string>> {
  const entries = Object.entries(I18N_STRINGS);
  const BATCH_SIZE = 100;
  const batches = splitI18nBatches(entries, BATCH_SIZE);
  const merged: Record<string, string> = {};
  const apiKey = getUmansTranslationKey() || _umansTranslationApiKey;
  if (!apiKey) throw new Error("no umans api key");
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const promptText = buildTranslatePrompt(locale, localeNative, batch);
    const expectedKeys = batch.map(([k]) => k);
    const respText = await callUmansFlashTranslateWithRetry(promptText, apiKey);
    const parsed = parseI18nBatchResponse(respText, expectedKeys);
    Object.assign(merged, parsed);
    console.log(`[i18n] Translated batch ${b + 1}/${batches.length} for ${locale} (${batch.length} strings)`);
  }
  return merged;
}

export async function ensureI18nForLocale(locale: string): Promise<{ locale: string; source: string; generated_at: string | null; strings: Record<string, string>; fallback_locale: string }> {
  if (!locale || locale === "en") return { locale: "en", source: "builtin", generated_at: null, strings: I18N_STRINGS, fallback_locale: "en" };
  const apiKey = getUmansTranslationKey();
  if (!apiKey) {
    console.log("[i18n] No UMANS API key, falling back to English");
    return { locale: "en", source: "builtin", generated_at: null, strings: I18N_STRINGS, fallback_locale: "en" };
  }
  const cached = loadI18nCache(locale);
  if (cached && cached.strings) return { ...cached, fallback_locale: locale };
  console.log(`[i18n] Generating translations for locale=${locale}...`);
  try {
    const strings = await translateCatalogForLocale(locale, locale);
    const result = { locale, source: "umans-flash", generated_at: new Date().toISOString(), strings, fallback_locale: locale };
    saveI18nCache(locale, result);
    console.log(`[i18n] Cached ${Object.keys(strings).length} strings for ${locale}`);
    return result;
  } catch (e: any) {
    console.error(`[i18n] Translation failed for ${locale}: ${e.message}`);
    return { locale: "en", source: "builtin", generated_at: null, strings: I18N_STRINGS, fallback_locale: "en" };
  }
}

let _forcedLocale: string | null = null;
export function setForcedLocale(locale: string | null) {
  _forcedLocale = locale ? String(locale).toLowerCase().split(/[-_]/)[0].slice(0, 8) : null;
}
export function getForcedLocale(): string | null { return _forcedLocale; }

export function getDashboardLocale(url: { searchParams: URLSearchParams }): string {
  if (_forcedLocale) return _forcedLocale;
  const queryLocale = url.searchParams.get("locale");
  if (queryLocale) return String(queryLocale).toLowerCase().split(/[-_]/)[0].slice(0, 8);
  const nav = url.searchParams.get("nav");
  if (nav) return String(nav).toLowerCase().split(/[-_]/)[0].slice(0, 8);
  return "en";
}

export function buildI18nBundle(locale: string): { locale: string; source: string; generated_at: string | null; strings: Record<string, string> } {
  if (!locale || locale === "en") return { locale: "en", source: "builtin", generated_at: null, strings: I18N_STRINGS };
  const cached = loadI18nCache(locale);
  if (cached && cached.strings) return cached;
  return { locale, source: "pending", generated_at: null, strings: I18N_STRINGS };
}
