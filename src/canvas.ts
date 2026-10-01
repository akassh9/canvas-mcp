// Minimal read-only Canvas client that authenticates with a browser session cookie.

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const BASE_URL = (process.env.CANVAS_BASE_URL ?? "https://canvas.wustl.edu").replace(/\/$/, "");
const COOKIE = process.env.CANVAS_COOKIE ?? "";

export class CanvasAuthError extends Error {}

function csrfToken(cookie: string): string | undefined {
  const match = cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function headers(): Record<string, string> {
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

async function request(url: string): Promise<{ body: unknown; next?: string }> {
  const res = await fetch(url, { headers: headers(), redirect: "manual" });
  // An expired session either 401s or redirects to the SSO login page.
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
    throw new CanvasAuthError("Canvas session expired or invalid. Refresh CANVAS_COOKIE in .env.");
  }
  const text = await res.text();
  if (res.status === 403) {
    throw new Error(`Canvas 403: this course hides that section from students (${new URL(url).pathname}).`);
  }
  if (!res.ok) throw new Error(`Canvas ${res.status} for ${url}: ${text.slice(0, 300)}`);
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

// ---- Typed helpers for the views students use most ----

type Course = {
  id: string;
  name: string;
  course_code: string;
  term?: { name: string };
  enrollments?: { type: string; computed_current_score?: number | null; computed_current_grade?: string | null }[];
};

export async function whoami() {
  const me = await get<{ id: string; name: string }>("/api/v1/users/self");
  return { id: me.id, name: me.name };
}

// Canvas keeps past courses "active" for years, so by default only return the courses
// shown on the dashboard (the current term's courses, or whatever the user favorited).
export async function courses(all = false) {
  const [list, cards] = await Promise.all([
    getAll<Course>("/api/v1/courses", {
      enrollment_state: "active",
      "include[]": ["total_scores", "term"],
    }),
    all ? Promise.resolve([]) : get<{ id: string }[]>("/api/v1/dashboard/dashboard_cards"),
  ]);
  const dashboard = new Set(cards.map((c) => c.id));
  return list
    .filter((c) => c.name && (all || dashboard.has(c.id)))
    .map((c) => {
      const enrollment = c.enrollments?.find((e) => e.type === "student") ?? c.enrollments?.[0];
      return {
        id: c.id,
        name: c.name,
        code: c.course_code,
        term: c.term?.name ?? null,
        current_score: enrollment?.computed_current_score ?? null,
        current_grade: enrollment?.computed_current_grade ?? null,
      };
    });
}

export async function todo(days = 14) {
  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  const items = await getAll<any>("/api/v1/planner/items", {
    start_date: start.toISOString(),
    end_date: end.toISOString(),
  });
  return items.map((i) => ({
    type: i.plannable_type,
    course: i.context_name,
    title: i.plannable?.title ?? i.plannable?.name,
    due: i.plannable_date,
    points: i.plannable?.points_possible ?? null,
    // Canvas reports null rather than false for things that haven't happened yet.
    submitted: i.submissions?.submitted === true,
    graded: i.submissions?.graded === true,
    missing: i.submissions?.missing === true,
    marked_done: i.planner_override?.marked_complete === true,
    url: i.html_url ? `${BASE_URL}${i.html_url}` : undefined,
  }));
}

export async function assignments(courseId: string, bucket?: string) {
  const list = await getAll<any>(`/api/v1/courses/${courseId}/assignments`, {
    "include[]": ["submission"],
    order_by: "due_at",
    bucket,
  });
  return list.map((a) => ({
    id: a.id,
    name: a.name,
    due: a.due_at,
    points: a.points_possible,
    score: a.submission?.score ?? null,
    grade: a.submission?.grade ?? null,
    state: a.submission?.workflow_state ?? null,
    missing: a.submission?.missing ?? null,
    late: a.submission?.late ?? null,
    url: a.html_url,
  }));
}

export async function announcements(courseIds: string[], days = 30) {
  const list = await getAll<any>("/api/v1/announcements", {
    "context_codes[]": courseIds.map((id) => `course_${id}`),
    start_date: new Date(Date.now() - days * 86_400_000).toISOString(),
    end_date: new Date().toISOString(),
  });
  return list.map((a) => ({
    course: a.context_code,
    title: a.title,
    posted: a.posted_at,
    author: a.author?.display_name,
    message: stripHtml(a.message ?? "").slice(0, 2000),
    url: a.html_url,
  }));
}

export async function modules(courseId: string) {
  const list = await getAll<any>(`/api/v1/courses/${courseId}/modules`, { "include[]": ["items"] });
  return list.map((m) => ({
    name: m.name,
    items: (m.items ?? []).map((i: any) => ({ type: i.type, title: i.title, url: i.html_url })),
  }));
}

export async function files(courseId: string, search?: string) {
  const list = await getAll<any>(`/api/v1/courses/${courseId}/files`, {
    search_term: search,
    sort: "updated_at",
    order: "desc",
  });
  return list.map((f) => ({
    id: f.id,
    name: f.display_name,
    size: f.size,
    updated: f.updated_at,
    url: f.url,
  }));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
