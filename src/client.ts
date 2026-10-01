// Low-level Canvas access: session-cookie auth, pagination, ID and date normalization.

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

export const BASE_URL = (process.env.CANVAS_BASE_URL ?? "https://canvas.wustl.edu").replace(/\/$/, "");
const COOKIE = process.env.CANVAS_COOKIE ?? "";

export class CanvasAuthError extends Error {}

const EXPIRED = "Canvas session expired or invalid. Refresh CANVAS_COOKIE in .env.";

function csrfToken(cookie: string): string | undefined {
  const match = cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function headers(): Record<string, string> {
  if (!COOKIE) {
    throw new CanvasAuthError("CANVAS_COOKIE is not set. Copy it from DevTools into .env (see README).");
  }
  const h: Record<string, string> = {
    Cookie: COOKIE,
    // Return IDs as strings: WashU IDs exceed Number.MAX_SAFE_INTEGER and would be rounded.
    Accept: "application/json+canvas-string-ids",
    "X-Requested-With": "XMLHttpRequest",
  };
  const csrf = csrfToken(COOKIE);
  if (csrf) h["X-CSRF-Token"] = csrf;
  return h;
}

// Canvas prefixes session-authenticated JSON with `while(1);` to block JSON hijacking.
function parseBody(text: string): unknown {
  const stripped = text.replace(/^while\(1\);/, "");
  return stripped ? JSON.parse(stripped) : null;
}

function nextLink(link: string | null): string | undefined {
  return link?.split(",").find((part) => part.includes('rel="next"'))?.match(/<([^>]+)>/)?.[1];
}

export type Params = Record<string, string | number | boolean | string[] | undefined>;

function buildUrl(path: string, params: Params = {}): string {
  const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function request(url: string): Promise<{ body: unknown; next?: string }> {
  const res = await fetch(url, { headers: headers(), redirect: "manual" });
  // An expired session either 401s or redirects to the SSO login page.
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new CanvasAuthError(EXPIRED);
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

// ---- IDs ----

// Canvas has two spellings of the same ID: global ("60780000000180256") and
// shard-local ("6078~180256", used in web URLs). Everything here uses the global form.
const SHARD_FACTOR = 10_000_000_000_000n;

// Some endpoints (e.g. planner) also return bare local IDs like "999436"; pass `sameShardAs`
// (any global ID from the same course) to expand those.
export function toGlobalId(id: string | number, sameShardAs?: string): string {
  const s = String(id).trim();
  const short = s.match(/^(\d+)~(\d+)$/);
  if (short) return (BigInt(short[1]) * SHARD_FACTOR + BigInt(short[2])).toString();
  if (!/^\d+$/.test(s)) throw new Error(`Not a Canvas ID: ${s}`);
  if (sameShardAs && BigInt(s) < SHARD_FACTOR) {
    const shard = BigInt(toGlobalId(sameShardAs)) / SHARD_FACTOR;
    if (shard > 0n) return (shard * SHARD_FACTOR + BigInt(s)).toString();
  }
  return s;
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

// Downloads bounce through a cross-domain login on the instructure.com host, which sets
// its own session cookie. Follow redirects by hand with a per-host cookie jar so the
// user's Canvas cookie is only ever sent to the Canvas host itself.
export async function fetchFile(fileId: string, courseId?: string) {
  const meta = await get<any>(courseId ? `/api/v1/courses/${courseId}/files/${fileId}` : `/api/v1/files/${fileId}`);
  if (!meta.url) throw new Error(`Canvas returned no download URL for file ${fileId} (it may be locked).`);

  const jar = new Map<string, Map<string, string>>();
  let url: string = meta.url;
  let res: Response | undefined;
  for (let hop = 0; hop < 10; hop++) {
    const host = new URL(url).host;
    const sameHost = host === new URL(BASE_URL).host;
    const picked = [...(jar.get(host) ?? new Map())].map(([k, v]) => `${k}=${v}`).join("; ");
    const h: Record<string, string> = sameHost ? headers() : {};
    if (picked) h.Cookie = sameHost ? `${h.Cookie}; ${picked}` : picked;
    res = await fetch(url, { headers: h, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) {
        if (!jar.has(host)) jar.set(host, new Map());
        jar.get(host)!.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) break;
    if (new URL(location, url).pathname.startsWith("/login")) throw new CanvasAuthError(EXPIRED);
    url = new URL(location, url).toString();
  }
  if (!res?.ok) throw new Error(`Download failed with status ${res?.status} for ${meta.display_name}`);

  return {
    id: meta.id as string,
    name: (meta.display_name || `canvas-file-${fileId}`) as string,
    contentType: (meta["content-type"] ?? "") as string,
    bytes: Buffer.from(await res.arrayBuffer()),
  };
}

// File IDs linked from HTML (pages, descriptions), in either ID spelling. Only links
// (href) count; images embedded in the page (src) are skipped.
export function linkedFileIds(html: string): string[] {
  const ids = [...html.matchAll(/href="[^"]*\/files\/(\d+(?:~\d+)?)/g)].map((m) => toGlobalId(m[1]));
  return [...new Set(ids)];
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
