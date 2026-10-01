// Course-wide search. Canvas's own smart search and the Pages list are often off for
// students, so this builds a small index from everything a student can read.

import { files, readFile } from "./canvas.ts";
import { BASE_URL, get, getAll, linkedFileIds, stripHtml, toGlobalId, tryGet } from "./client.ts";

type Doc = {
  type: "syllabus" | "front_page" | "page" | "assignment" | "quiz" | "discussion" | "announcement" | "module" | "file";
  title: string;
  text: string;
  url?: string;
  ids: Record<string, string>;
};

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; docs: Promise<Doc[]> }>();

export function courseIndex(courseId: string): Promise<Doc[]> {
  const hit = cache.get(courseId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.docs;
  const docs = buildIndex(courseId);
  cache.set(courseId, { at: Date.now(), docs });
  docs.catch(() => cache.delete(courseId));
  return docs;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// Link text for each linked file, so a PDF linked as "Syllabus" is findable by that word.
function fileLinks(html: string, from: string): { id: string; label: string; from: string }[] {
  const labels = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*href="[^"]*\/files\/(\d+(?:~\d+)?)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    labels.set(toGlobalId(m[1]), stripHtml(m[2]));
  }
  return linkedFileIds(html).map((id) => ({ id, label: labels.get(id) ?? "", from }));
}

async function buildIndex(courseId: string): Promise<Doc[]> {
  const c = `/api/v1/courses/${courseId}`;
  const [course, frontPage, moduleList, pageList, assignmentList, quizList, discussionList, announcementList, fileList] =
    await Promise.all([
      get<any>(c, { "include[]": ["syllabus_body"] }),
      tryGet(() => get<any>(`${c}/front_page`), null),
      tryGet(() => getAll<any>(`${c}/modules`, { "include[]": ["items"] }), []),
      tryGet(() => getAll<any>(`${c}/pages`), []),
      tryGet(() => getAll<any>(`${c}/assignments`), []),
      tryGet(() => getAll<any>(`${c}/quizzes`), []),
      tryGet(() => getAll<any>(`${c}/discussion_topics`), []),
      tryGet(
        () =>
          getAll<any>("/api/v1/announcements", {
            "context_codes[]": [`course_${courseId}`],
            start_date: new Date(Date.now() - 365 * 86_400_000).toISOString(),
            end_date: new Date().toISOString(),
          }),
        [],
      ),
      tryGet(() => files(courseId), null),
    ]);

  const docs: Doc[] = [];
  const links: { id: string; label: string; from: string }[] = [];
  const addHtml = (doc: Omit<Doc, "text">, html: string) => {
    docs.push({ ...doc, text: stripHtml(html) });
    links.push(...fileLinks(html, doc.title));
  };

  if (course.syllabus_body) {
    addHtml({ type: "syllabus", title: "Syllabus", url: `${BASE_URL}/courses/${courseId}/assignments/syllabus`, ids: {} }, course.syllabus_body);
  }
  if (frontPage?.body) {
    addHtml({ type: "front_page", title: frontPage.title ?? "Front page", url: frontPage.html_url, ids: { page_url: frontPage.url } }, frontPage.body);
  }

  // The Pages list is often hidden, but pages linked from modules can still be fetched one by one.
  const pageUrls = new Set<string>(pageList.map((p: any) => p.url));
  for (const m of moduleList) {
    for (const i of m.items ?? []) if (i.type === "Page" && i.page_url) pageUrls.add(i.page_url);
    const titles = (m.items ?? []).map((i: any) => `${i.type}: ${i.title}`).join("\n");
    docs.push({ type: "module", title: m.name, text: titles, ids: { module_id: m.id } });
    for (const i of m.items ?? []) {
      if (i.type === "File" && i.content_id) links.push({ id: i.content_id, label: i.title, from: `module ${m.name}` });
    }
  }
  pageUrls.delete(frontPage?.url);
  const pages = await mapLimit([...pageUrls].slice(0, 80), 6, (url) => tryGet(() => get<any>(`${c}/pages/${url}`), null));
  for (const p of pages) {
    if (p) addHtml({ type: "page", title: p.title, url: p.html_url, ids: { page_url: p.url } }, p.body ?? "");
  }

  for (const a of assignmentList) {
    addHtml({ type: "assignment", title: a.name, url: a.html_url, ids: { assignment_id: a.id } }, a.description ?? "");
  }
  for (const q of quizList) {
    const ids: Record<string, string> = { quiz_id: q.id };
    if (q.assignment_id) ids.assignment_id = q.assignment_id;
    addHtml({ type: "quiz", title: q.title, url: q.html_url, ids }, q.description ?? "");
  }
  for (const d of discussionList) {
    addHtml({ type: "discussion", title: d.title, url: d.html_url, ids: { discussion_id: d.id } }, d.message ?? "");
  }
  for (const a of announcementList) {
    addHtml({ type: "announcement", title: a.title, url: a.html_url, ids: { announcement_id: a.id } }, a.message ?? "");
  }

  // Files: the Files tab if visible, plus every file linked from content (works even when the tab is hidden).
  const fileDocs = new Map<string, { name: string; labels: Set<string>; from: Set<string> }>();
  for (const f of fileList ?? []) fileDocs.set(f.file_id, { name: f.name, labels: new Set(), from: new Set(["Files tab"]) });
  const unknown = [...new Set(links.map((l) => l.id))].filter((id) => !fileDocs.has(id));
  const metas = await mapLimit(unknown.slice(0, 150), 6, (id) => tryGet(() => get<any>(`${c}/files/${id}`), null));
  for (const m of metas) if (m) fileDocs.set(m.id, { name: m.display_name, labels: new Set(), from: new Set() });
  for (const l of links) {
    const f = fileDocs.get(l.id);
    if (!f) continue;
    if (l.label && l.label !== f.name) f.labels.add(l.label);
    f.from.add(l.from);
  }
  for (const [id, f] of fileDocs) {
    const labels = [...f.labels].map((l) => `linked as "${l}"`).join("; ");
    docs.push({
      type: "file",
      title: f.name,
      text: [labels, `found in: ${[...f.from].join(", ")}`].filter(Boolean).join("\n"),
      ids: { file_id: id },
    });
  }
  return docs;
}

export async function search(courseId: string, query: string, types?: string[], limit = 10) {
  const docs = await courseIndex(courseId);
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))];
  if (!terms.length) throw new Error("Query needs at least one word of 2+ characters.");
  const phrase = query.toLowerCase().trim();

  const scored = docs
    .filter((d) => !types?.length || types.includes(d.type))
    .map((d) => {
      const title = d.title.toLowerCase();
      const text = d.text.toLowerCase();
      let matched = 0;
      let score = 0;
      for (const t of terms) {
        const inTitle = title.includes(t);
        const count = Math.min(text.split(t).length - 1, 10);
        if (inTitle || count) matched++;
        score += (inTitle ? 10 : 0) + count;
      }
      if (terms.length > 1 && (title.includes(phrase) || text.includes(phrase))) score += 20;
      return { d, matched, score };
    })
    .filter((r) => r.matched > 0)
    .sort((a, b) => b.matched - a.matched || b.score - a.score);

  const best = scored[0]?.matched ?? 0;
  const results = scored
    .filter((r) => r.matched === best)
    .slice(0, limit)
    .map(({ d }) => ({
      type: d.type,
      title: d.title,
      ...d.ids,
      snippet: snippet(d.text, terms),
      url: d.url,
    }));

  return {
    query,
    matched_terms: `${best}/${terms.length}`,
    results,
    searched: summarize(docs),
    note: "Searches titles and text of pages, assignments, quizzes, discussions, announcements, modules, and file names/link labels. It does not search inside files; use canvas_read_file for that.",
  };
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return text.slice(0, 200);
  const start = Math.max(0, at - 100);
  return (start > 0 ? "…" : "") + text.slice(start, start + 260).replace(/\s+/g, " ") + (start + 260 < text.length ? "…" : "");
}

function summarize(docs: Doc[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of docs) counts[d.type] = (counts[d.type] ?? 0) + 1;
  return counts;
}

// Tries, in order: Canvas's Syllabus tab, a file or page named or linked as "syllabus".
export async function syllabus(courseId: string, maxChars = 20_000) {
  const docs = await courseIndex(courseId);
  const tab = docs.find((d) => d.type === "syllabus" && d.text.length > 50);
  const isSyllabus = (d: Doc) => /syllab/i.test(d.title) || /linked as "[^"]*syllab/i.test(d.text);
  const file = docs.find((d) => d.type === "file" && isSyllabus(d));
  const page = docs.find((d) => (d.type === "page" || d.type === "front_page") && /syllab/i.test(d.title));

  if (file) {
    try {
      const content = await readFile(file.ids.file_id, courseId, 0, maxChars);
      return { source: `file: ${file.title}`, ...content, ...(tab ? { also: "The Syllabus tab has text too." } : {}) };
    } catch (err) {
      if (!tab && !page) return { source: `file: ${file.title}`, file_id: file.ids.file_id, error: (err as Error).message };
    }
  }
  const doc = tab ?? page;
  if (doc) return { source: doc.type === "syllabus" ? "Syllabus tab" : `page: ${doc.title}`, url: doc.url, text: doc.text.slice(0, maxChars) };
  return {
    found: false,
    searched: summarize(docs),
    hint: "No syllabus found. Try canvas_search with words from the syllabus (e.g. 'grading', 'office hours').",
  };
}

// Files tab when visible; otherwise files linked from the course's content.
export async function courseFiles(courseId: string, query?: string) {
  const listed = await tryGet(() => files(courseId, query), null);
  if (listed) return { source: "Files tab", files: listed };
  const docs = await courseIndex(courseId);
  const q = query?.toLowerCase();
  const linked = docs
    .filter((d) => d.type === "file" && (!q || d.title.toLowerCase().includes(q) || d.text.toLowerCase().includes(q)))
    .map((d) => ({ file_id: d.ids.file_id, name: d.title, where: d.text }));
  return {
    source: "The Files tab is hidden in this course; these are files linked from its pages, modules, and assignments.",
    files: linked,
  };
}
