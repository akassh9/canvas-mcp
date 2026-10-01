// Read-only Canvas helpers that return compact, model-friendly shapes.
// IDs are always the global form; dates come with local time and a relative hint.

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile as readFs, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import {
  BASE_URL,
  dueFields,
  fetchFile,
  get,
  getAll,
  linkedFileIds,
  stripHtml,
  toGlobalId,
  tryGet,
  userTimeZone,
} from "./client.ts";

export { CanvasAuthError, get, getAll, toGlobalId } from "./client.ts";

type Submission = {
  score: number | null;
  grade: string | null;
  excused: boolean | null;
  missing: boolean | null;
  late: boolean | null;
  submitted_at: string | null;
  workflow_state: string;
};

type Assignment = {
  id: string;
  name: string;
  due_at: string | null;
  points_possible: number | null;
  omit_from_final_grade?: boolean;
  html_url: string;
  submission?: Submission;
  description?: string | null;
  submission_types?: string[];
  assignment_group_id?: string;
};

// A short status a model can relay without interpreting several booleans.
function status(a: Assignment): string {
  const s = a.submission;
  if (!s) return "unknown";
  if (s.excused) return "excused";
  if (s.score !== null && s.score !== undefined) return "graded";
  if (s.submitted_at) return "submitted, awaiting grade";
  if (s.missing) return "missing";
  if (a.due_at && new Date(a.due_at) < new Date()) return "past due, not submitted";
  return "not submitted";
}

export async function whoami() {
  const [me, tz] = await Promise.all([get<{ id: string; name: string }>("/api/v1/users/self"), userTimeZone()]);
  return { user_id: me.id, name: me.name, time_zone: tz };
}

type Course = {
  id: string;
  name: string;
  course_code: string;
  hide_final_grades?: boolean;
  apply_assignment_group_weights?: boolean;
  term?: { name: string };
  enrollments?: { type: string; computed_current_score?: number | null }[];
};

let courseNameCache: Promise<Map<string, string>> | undefined;

export function courseNames(): Promise<Map<string, string>> {
  courseNameCache ??= getAll<Course>("/api/v1/courses", { enrollment_state: "active" }).then(
    (list) => new Map(list.map((c) => [c.id, c.name])),
  );
  return courseNameCache;
}

// Canvas keeps past courses "active" for years, so by default only return the courses
// shown on the dashboard (the current term's courses, or whatever the user favorited).
export async function courses(all = false) {
  const [list, cards] = await Promise.all([
    getAll<Course>("/api/v1/courses", { enrollment_state: "active", "include[]": ["total_scores", "term"] }),
    all ? Promise.resolve([]) : get<{ id: string }[]>("/api/v1/dashboard/dashboard_cards"),
  ]);
  const dashboard = new Set(cards.map((c) => c.id));
  const picked = list.filter((c) => c.name && (all || dashboard.has(c.id)));

  return Promise.all(
    picked.map(async (c) => {
      const items = await tryGet(
        () => getAll<Assignment>(`/api/v1/courses/${c.id}/assignments`, { "include[]": ["submission"] }),
        null,
      );
      const counted = items?.filter((a) => !a.omit_from_final_grade && (a.points_possible ?? 0) > 0);
      const statuses = counted?.map(status) ?? [];
      const graded = statuses.filter((s) => s === "graded").length;
      const awaiting = statuses.filter((s) => s === "submitted, awaiting grade").length;
      const score = c.enrollments?.find((e) => e.type === "student")?.computed_current_score ?? null;

      let scoreNote: string | undefined;
      if (score === null) {
        if (c.hide_final_grades) scoreNote = "The instructor hides the course total from students.";
        else if (counted && graded === 0) scoreNote = "No graded work yet.";
        else scoreNote = "Canvas returned no course total.";
      }
      return {
        course_id: c.id,
        name: c.name,
        code: c.course_code,
        term: c.term?.name ?? null,
        current_score: score,
        ...(scoreNote ? { score_note: scoreNote } : {}),
        grading: c.apply_assignment_group_weights ? "weighted by assignment group" : "total points",
        assignments_total: counted?.length ?? null,
        graded_count: counted ? graded : null,
        awaiting_grade_count: counted ? awaiting : null,
      };
    }),
  );
}

export async function todo(days = 14) {
  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  const [items, tz] = await Promise.all([
    getAll<any>("/api/v1/planner/items", { start_date: start.toISOString(), end_date: end.toISOString() }),
    userTimeZone(),
  ]);
  return items.map((i) => {
    const s = i.submissions || {};
    // The planner mixes global and bare local IDs; expand everything to the course's shard.
    const ref = i.course_id ? String(i.course_id) : undefined;
    const id = (v: unknown) => (v === null || v === undefined ? null : toGlobalId(String(v), ref));
    return {
      type: i.plannable_type,
      title: i.plannable?.title ?? i.plannable?.name,
      course_id: id(i.course_id),
      course: i.context_name,
      ...(i.plannable_type === "assignment" ? { assignment_id: id(i.plannable_id) } : {}),
      ...(i.plannable_type === "quiz" ? { quiz_id: id(i.plannable_id), assignment_id: id(i.plannable?.assignment_id) } : {}),
      ...(!["assignment", "quiz"].includes(i.plannable_type) ? { item_id: id(i.plannable_id) } : {}),
      ...dueFields(i.plannable_date, tz),
      points: i.plannable?.points_possible ?? null,
      // Canvas reports null rather than false for things that haven't happened yet.
      submitted: s.submitted === true,
      graded: s.graded === true,
      missing: s.missing === true,
      marked_done: i.planner_override?.marked_complete === true,
      url: i.html_url ? `${BASE_URL}${i.html_url}` : undefined,
    };
  });
}

export async function assignments(courseId: string, bucket?: string) {
  const [list, tz] = await Promise.all([
    getAll<Assignment>(`/api/v1/courses/${courseId}/assignments`, {
      "include[]": ["submission"],
      order_by: "due_at",
      bucket,
    }),
    userTimeZone(),
  ]);
  return list.map((a) => ({
    assignment_id: a.id,
    course_id: courseId,
    name: a.name,
    ...dueFields(a.due_at, tz),
    points: a.points_possible,
    status: status(a),
    score: a.submission?.score ?? null,
    late: a.submission?.late === true,
    url: a.html_url,
  }));
}

// Instructors usually attach handouts as links inside the description, not as Canvas "attachments".
export async function assignment(courseId: string, assignmentId: string) {
  const [a, tz] = await Promise.all([
    get<Assignment>(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, { "include[]": ["submission"] }),
    userTimeZone(),
  ]);
  const html = a.description ?? "";
  const linkedFiles = await Promise.all(
    linkedFileIds(html).map(async (id) => {
      try {
        const f = await get<any>(`/api/v1/courses/${courseId}/files/${id}`);
        return { file_id: f.id, name: f.display_name, size: f.size, content_type: f["content-type"] };
      } catch (err) {
        return { file_id: id, error: (err as Error).message };
      }
    }),
  );
  return {
    assignment_id: a.id,
    course_id: courseId,
    name: a.name,
    ...dueFields(a.due_at, tz),
    points: a.points_possible,
    submission_types: a.submission_types,
    status: status(a),
    score: a.submission?.score ?? null,
    description: stripHtml(html).slice(0, 8000),
    linked_files: linkedFiles,
    url: a.html_url,
  };
}

export async function announcements(courseIds: string[], days = 30) {
  const [list, names, tz] = await Promise.all([
    getAll<any>("/api/v1/announcements", {
      "context_codes[]": courseIds.map((id) => `course_${id}`),
      start_date: new Date(Date.now() - days * 86_400_000).toISOString(),
      end_date: new Date().toISOString(),
    }),
    courseNames(),
    userTimeZone(),
  ]);
  return list.map((a) => {
    const courseId = String(a.context_code ?? "").replace(/^course_/, "");
    return {
      course_id: courseId,
      course: names.get(courseId) ?? null,
      title: a.title,
      ...dueFields(a.posted_at, tz, "posted"),
      author: a.author?.display_name,
      message: stripHtml(a.message ?? "").slice(0, 3000),
      url: a.html_url,
    };
  });
}

export async function modules(courseId: string) {
  const list = await getAll<any>(`/api/v1/courses/${courseId}/modules`, { "include[]": ["items"] });
  return list.map((m) => ({
    name: m.name,
    items: (m.items ?? []).map((i: any) => ({
      type: i.type,
      title: i.title,
      ...(i.type === "Page" ? { page_url: i.page_url } : {}),
      ...(["File", "Assignment", "Quiz", "Discussion"].includes(i.type)
        ? { [`${i.type.toLowerCase()}_id`]: i.content_id }
        : {}),
      url: i.html_url,
    })),
  }));
}

export async function files(courseId: string, search?: string) {
  const list = await getAll<any>(`/api/v1/courses/${courseId}/files`, {
    search_term: search,
    sort: "updated_at",
    order: "desc",
  });
  return list.map((f) => ({
    file_id: f.id,
    name: f.display_name,
    size: f.size,
    content_type: f["content-type"],
    updated: f.updated_at,
  }));
}

// ---- Grades ----

// Approximates Canvas's current-score math so a model can explain where a grade comes from.
// Canvas's own number (canvas_current_score) stays the source of truth.
export async function gradeBreakdown(courseId: string) {
  const [course, groups, tz] = await Promise.all([
    get<Course>(`/api/v1/courses/${courseId}`, { "include[]": ["total_scores"] }),
    getAll<any>(`/api/v1/courses/${courseId}/assignment_groups`, { "include[]": ["assignments", "submission"] }),
    userTimeZone(),
  ]);
  const weighted = course.apply_assignment_group_weights === true;
  const allCounted = groups.flatMap((g) => countedAssignments(g.assignments));
  const coursePoints = allCounted.reduce((sum, a) => sum + (a.points_possible ?? 0), 0);

  const out = groups
    .filter((g) => (g.assignments?.length ?? 0) > 0 || (weighted && g.group_weight > 0))
    .map((g) => {
      const items = countedAssignments(g.assignments ?? []);
      const rules = g.rules ?? {};
      const neverDrop = new Set<string>((rules.never_drop ?? []).map(String));
      const graded = items.filter((a) => status(a) === "graded");

      // Canvas drops the lowest/highest graded scores by percentage, keeping at least one.
      const droppable = graded
        .filter((a) => !neverDrop.has(a.id))
        .sort((x, y) => pct(x) - pct(y));
      const dropLow = Math.min(rules.drop_lowest ?? 0, Math.max(graded.length - 1, 0));
      const dropHigh = Math.min(rules.drop_highest ?? 0, Math.max(graded.length - 1 - dropLow, 0));
      const dropped = new Set([
        ...droppable.slice(0, dropLow).map((a) => a.id),
        ...droppable.slice(droppable.length - dropHigh).map((a) => a.id),
      ]);

      const kept = graded.filter((a) => !dropped.has(a.id));
      const earned = kept.reduce((sum, a) => sum + (a.submission!.score ?? 0), 0);
      const possible = kept.reduce((sum, a) => sum + (a.points_possible ?? 0), 0);
      const groupPoints = items.reduce((sum, a) => sum + (a.points_possible ?? 0), 0);
      const totalDrops = (rules.drop_lowest ?? 0) + (rules.drop_highest ?? 0);
      // Drops spread a group's weight over fewer items, so each counted item is worth more.
      const dropScale = items.length > totalDrops ? items.length / (items.length - totalDrops) : 1;

      return {
        group: g.name,
        weight_pct: weighted ? g.group_weight : null,
        rules: {
          ...(rules.drop_lowest ? { drop_lowest: rules.drop_lowest } : {}),
          ...(rules.drop_highest ? { drop_highest: rules.drop_highest } : {}),
        },
        items_posted: items.length,
        graded_count: graded.length,
        score_pct: possible > 0 ? round((earned / possible) * 100) : null,
        points: possible > 0 ? `${round(earned)}/${round(possible)}` : null,
        ...(items.length === 0 ? { note: "No assignments posted in this group yet." } : {}),
        items: items.map((a) => ({
          assignment_id: a.id,
          name: a.name,
          ...dueFields(a.due_at, tz),
          points: a.points_possible,
          score: a.submission?.score ?? null,
          status: status(a),
          ...(dropped.has(a.id) ? { dropped: true } : {}),
          share_of_final_pct: weighted
            ? groupPoints > 0
              ? round(((g.group_weight * (a.points_possible ?? 0)) / groupPoints) * dropScale)
              : null
            : coursePoints > 0
              ? round(((a.points_possible ?? 0) / coursePoints) * 100)
              : null,
        })),
        _earned: earned,
        _possible: possible,
        _weight: g.group_weight ?? 0,
      };
    });

  let estimate: number | null = null;
  if (weighted) {
    // Like Canvas, re-normalize over groups that have graded work.
    const active = out.filter((g) => g._possible > 0 && g._weight > 0);
    const weightSum = active.reduce((sum, g) => sum + g._weight, 0);
    if (weightSum > 0) {
      estimate = round(active.reduce((sum, g) => sum + (g._earned / g._possible) * g._weight, 0) / weightSum * 100);
    }
  } else {
    const earned = out.reduce((sum, g) => sum + g._earned, 0);
    const possible = out.reduce((sum, g) => sum + g._possible, 0);
    if (possible > 0) estimate = round((earned / possible) * 100);
  }

  return {
    course_id: courseId,
    course: course.name,
    grading: weighted
      ? "Weighted by assignment group (weights below)."
      : "Total points. Canvas does not apply group weights here, so any weights in the syllabus are NOT reflected in the Canvas score.",
    canvas_current_score: course.enrollments?.find((e) => e.type === "student")?.computed_current_score ?? null,
    estimated_current_score: estimate,
    estimate_note:
      "Estimate from graded work only, applying drop rules. Canvas's number is authoritative if they differ. share_of_final_pct assumes all posted items in a group count equally after drops.",
    groups: out.map(({ _earned, _possible, _weight, ...g }) => g),
  };
}

function countedAssignments(list: Assignment[]): Assignment[] {
  return list.filter((a) => !a.omit_from_final_grade && (a.points_possible ?? 0) > 0);
}

function pct(a: Assignment): number {
  return (a.submission?.score ?? 0) / (a.points_possible || 1);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---- Files ----

// Saves a file to disk. Never overwrites: if an identical copy already exists (same name
// or a "(n)" variant with the same bytes), returns that path instead of saving again.
export async function downloadFile(fileId: string, dir = join(homedir(), "Downloads"), courseId?: string) {
  const file = await fetchFile(fileId, courseId);
  await mkdir(dir, { recursive: true });
  const name = basename(file.name);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const path = join(dir, n ? `${stem} (${n})${ext}` : name);
    let existing: Buffer | undefined;
    try {
      await access(path);
      existing = await readFs(path);
    } catch {
      await writeFile(path, file.bytes, { flag: "wx" });
      return { file_id: file.id, path, name: file.name, size: file.bytes.length, already_downloaded: false };
    }
    if (existing.equals(file.bytes)) {
      return { file_id: file.id, path, name: file.name, size: file.bytes.length, already_downloaded: true };
    }
  }
}

const execFileAsync = promisify(execFile);
const PDFTOTEXT = ["pdftotext", "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext"];

async function pdfToText(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "canvas-mcp-"));
  const pdf = join(dir, "file.pdf");
  try {
    await writeFile(pdf, bytes);
    for (const bin of PDFTOTEXT) {
      try {
        return (await execFileAsync(bin, ["-layout", pdf, "-"], { maxBuffer: 50 * 1024 * 1024 })).stdout;
      } catch (err: any) {
        if (err.code !== "ENOENT") throw new Error(`pdftotext failed: ${err.message}`);
      }
    }
    throw new Error("Reading PDFs needs pdftotext. Install it with: brew install poppler");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-csv|javascript))/;

// Returns a file's text without saving it. Long files are paged with offset/max_chars.
export async function readFile(fileId: string, courseId?: string, offset = 0, maxChars = 20_000) {
  const file = await fetchFile(fileId, courseId);
  const ext = extname(file.name).toLowerCase();
  let text: string;
  if (file.contentType === "application/pdf" || ext === ".pdf") text = await pdfToText(file.bytes);
  else if (file.contentType === "text/html" || ext === ".html" || ext === ".htm") text = stripHtml(file.bytes.toString("utf8"));
  else if (TEXT_TYPES.test(file.contentType) || [".txt", ".md", ".csv", ".json"].includes(ext)) text = file.bytes.toString("utf8");
  else {
    throw new Error(
      `Can't extract text from ${file.name} (${file.contentType || ext}). Use canvas_download_file and open it instead.`,
    );
  }
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  const slice = text.slice(offset, offset + maxChars);
  const end = offset + slice.length;
  return {
    file_id: file.id,
    name: file.name,
    total_chars: text.length,
    offset,
    ...(end < text.length ? { truncated: true, next_offset: end } : {}),
    text: slice,
  };
}
