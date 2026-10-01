// Low-level Canvas access: session-cookie auth, pagination, ID and date normalization.

import { logout as clearSession, loadStored, refreshSession, type Session } from "./session.ts";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

// WashU's canonical Canvas host. canvas.wustl.edu serves the same Canvas, but signing in through
// it lands on a "No Canvas Account Found" page, so log in and call the API here instead.
export const BASE_URL = (process.env.CANVAS_BASE_URL || "https://wustl.instructure.com").replace(/\/$/, "");
const ENV_COOKIE = process.env.CANVAS_COOKIE?.trim() || undefined;
// Set CANVAS_AUTO_LOGIN=0 to never open a login window automatically.
const AUTO_LOGIN = process.env.CANVAS_AUTO_LOGIN !== "0";
// How long a tool call waits for the user to finish signing in before giving up for now.
const LOGIN_WAIT_MS = Number(process.env.CANVAS_LOGIN_WAIT_MS ?? 90_000);

export class CanvasAuthError extends Error {}

const LOGIN_HINT = "Run `npm run login` in the canvas-mcp folder.";
const EXPIRED = `Canvas session expired. ${LOGIN_HINT}`;

// The saved session (Keychain) wins over .env; .env still works for manual setups.
let session: Promise<Session | undefined> | undefined;

function currentSession(): Promise<Session | undefined> {
  session ??= loadStored(BASE_URL).then((s) => s ?? (ENV_COOKIE ? { cookie: ENV_COOKIE, source: ".env" } : undefined));
  return session;
}

export async function sessionSource(): Promise<string | null> {
  return (await currentSession())?.source ?? null;
}

// Refreshes the session after Canvas rejects `rejected` (or when there is none). If the user
// has to sign in, waits up to LOGIN_WAIT_MS; the login window stays open after that, and the
// next call picks up the new session.
async function recover(rejected?: string): Promise<void> {
  if (!AUTO_LOGIN) throw new CanvasAuthError(rejected ? EXPIRED : `Not signed in to Canvas. ${LOGIN_HINT}`);
  const refresh = refreshSession(BASE_URL, { rejected, envCookie: ENV_COOKIE });
  refresh.then(
    (s) => (session = Promise.resolve(s)),
    () => (session = undefined),
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), LOGIN_WAIT_MS)));
  try {
    const outcome = await Promise.race([refresh.then(() => "ok" as const), timeout]);
    if (outcome === "timeout") {
      throw new CanvasAuthError(
        "The Canvas session expired, so a Canvas sign-in window is open. Ask the user to finish signing in there, then try again.",
      );
    }
  } catch (err) {
    if (err instanceof CanvasAuthError) throw err;
    throw new CanvasAuthError(`Canvas sign-in didn't finish: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Explicit login (CLI / canvas_login tool). Reuses a still-valid session unless `force`.
export async function login(
  opts: { force?: boolean; onWindow?: () => void; log?: (msg: string) => void } = {},
): Promise<Session> {
  const s = await refreshSession(BASE_URL, { ...opts, envCookie: ENV_COOKIE, timeoutMs: 5 * 60_000 });
  session = Promise.resolve(s);
  return s;
}

export async function logout(): Promise<void> {
  await clearSession(BASE_URL);
  session = undefined;
}

export async function headers(): Promise<Record<string, string>> {
  let s = await currentSession();
  if (!s) {
    await recover();
    s = await currentSession();
  }
  if (!s) throw new CanvasAuthError(`Not signed in to Canvas. ${LOGIN_HINT}`);
  return {
    Cookie: s.cookie,
    // IDs as strings: cross-shard IDs exceed Number.MAX_SAFE_INTEGER and would be rounded.
    Accept: "application/json+canvas-string-ids",
  };
}

// Canvas prefixes session-authenticated JSON with `while(1);` to block JSON hijacking.
function parseBody(text: string): unknown {
  const stripped = text.replace(/^while\(1\);/, "");
  return stripped ? JSON.parse(stripped) : null;
}

function nextLink(link: string | null): string | undefined {
  return link?.split(",").find((part) => part.includes('rel="next"'))?.match(/<([^>]+)>/)?.[1];
}

type Params = Record<string, string | number | boolean | string[] | undefined>;

function buildUrl(path: string, params: Params = {}): string {
  const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function request(url: string, retried = false): Promise<{ body: unknown; next?: string }> {
  const h = await headers();
  const res = await fetch(url, { headers: h, redirect: "manual" });
  // An expired session either 401s or redirects to the SSO login page.
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
    if (retried) throw new CanvasAuthError(EXPIRED);
    await recover(h.Cookie);
    return request(url, true);
  }
  const text = await res.text();
  if (res.status === 403) {
    throw new Error(`Canvas 403: not available to students in this course (${new URL(url).pathname}).`);
  }
  if (!res.ok) throw new Error(`Canvas ${res.status} for ${new URL(url).pathname}: ${text.slice(0, 300)}`);
  return { body: parseBody(text), next: nextLink(res.headers.get("link")) };
}

export async function get<T = unknown>(path: string, params: Params = {}): Promise<T> {
  return (await request(buildUrl(path, params))).body as T;
}

// Follows Link-header pagination until exhausted or `limit` items are collected.
export async function getAll<T = unknown>(path: string, params: Params = {}, limit = 500): Promise<T[]> {
  const items: T[] = [];
  let url: string | undefined = buildUrl(path, { per_page: 100, ...params });
  while (url && items.length < limit) {
    const { body, next } = await request(url);
    items.push(...(body as T[]));
    url = next;
  }
  return items.slice(0, limit);
}

// Like get/getAll, but resolves to `fallback` when Canvas hides the resource (403/404).
export async function tryGet<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CanvasAuthError) throw err;
    return fallback;
  }
}

// ---- Dates ----

let timeZone: Promise<string> | undefined;

// The user's Canvas profile time zone, so due times match what the Canvas UI shows.
export function userTimeZone(): Promise<string> {
  timeZone ??= process.env.CANVAS_TIME_ZONE
    ? Promise.resolve(process.env.CANVAS_TIME_ZONE)
    : tryGet(() => get<{ time_zone?: string }>("/api/v1/users/self/profile"), {}).then(
        (p) => p.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
  return timeZone;
}

// e.g. { due: "2026-10-02T04:59:59Z", due_local: "Thu, Oct 1, 11:59 PM CDT", due_in: "in 13 hours" }
export function dueFields(iso: string | null | undefined, tz: string, key = "due") {
  if (!iso) return { [key]: null };
  const date = new Date(iso);
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return { [key]: iso, [`${key}_local`]: local, [`${key}_in`]: relative(date) };
}

function relative(date: Date): string {
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const hours = Math.round(abs / 3_600_000);
  const amount = hours < 1 ? "under an hour" : hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
  return diff >= 0 ? `in ${amount}` : `${amount} ago`;
}

// ---- Files ----

// The Canvas host redirects downloads to a signed, short-lived URL on its file servers. Only
// that first request carries the session cookie; the signed URL needs none.
export async function fetchFile(fileId: string, courseId?: string) {
  const meta = await get<any>(courseId ? `/api/v1/courses/${courseId}/files/${fileId}` : `/api/v1/files/${fileId}`);
  if (!meta.url) throw new Error(`Canvas returned no download URL for file ${fileId} (it may be locked).`);

  const first = await fetch(meta.url, { headers: await headers(), redirect: "manual" });
  const location = first.headers.get("location");
  if (first.status === 401 || (location && new URL(location, meta.url).pathname.startsWith("/login"))) {
    throw new CanvasAuthError(EXPIRED);
  }
  const res = location ? await fetch(new URL(location, meta.url)) : first;
  if (!res.ok) throw new Error(`Download failed with status ${res.status} for ${meta.display_name}`);

  return {
    id: meta.id as string,
    name: (meta.display_name || `canvas-file-${fileId}`) as string,
    contentType: (meta["content-type"] ?? "") as string,
    bytes: Buffer.from(await res.arrayBuffer()),
  };
}

// File IDs linked from HTML (pages, descriptions). Only links (href) count; images embedded
// in the page (src) are skipped.
export function linkedFileIds(html: string): string[] {
  return [...new Set([...html.matchAll(/href="[^"]*\/files\/(\d+(?:~\d+)?)/g)].map((m) => m[1]))];
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h\d|tr|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
