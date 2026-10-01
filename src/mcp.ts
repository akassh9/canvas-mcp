import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as canvas from "./canvas.ts";
import { login, toGlobalId } from "./client.ts";
import * as search from "./search.ts";

const TOOL_NAMES = [
  "courses", "todo", "assignments", "assignment", "grade_breakdown", "announcements", "modules",
  "files", "search", "syllabus", "read_file", "download_file", "get", "whoami", "login",
].map((t) => `canvas_${t}`);

// Shown to the model in its system prompt. Smaller models in particular tried to reach
// this server through Bash or HTTP when its tools were deferred, so spell out the basics.
const INSTRUCTIONS = `Read-only access to the user's Canvas LMS (their courses, assignments, grades, files).

- These are tools: call them directly. There is no CLI, shell command, or HTTP endpoint for this server.
- If the tools are deferred, load them all in ONE ToolSearch call, e.g. "select:" followed by the full names of: ${TOOL_NAMES.join(", ")} (each prefixed the way your tool list shows, typically mcp__canvas__).
- Get course_id values from canvas_courses first. "What's due" questions: canvas_todo.
- If a tool says a Canvas sign-in window is open, ask the user to finish signing in there, then retry. Don't ask them for passwords or cookies.
- When telling the user a date, use the *_local and *_in fields (the user's time zone), never the UTC field.
- Grade composition / "how much is X worth": canvas_grade_breakdown. Syllabus: canvas_syllabus. "Is there / where is X": canvas_search.`;

const server = new McpServer({ name: "canvas", version: "0.2.0" }, { instructions: INSTRUCTIONS });

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return result(await fn());
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
  }
}

// Accepts both ID spellings Canvas uses ("60780000000180256" or "6078~180256").
const canvasId = (what: string) =>
  z.coerce
    .string()
    .regex(/^\d+(~\d+)?$/, `${what} must be a Canvas ID like 60780000000180256 or 6078~180256`)
    .describe(`Canvas ${what} (either ID format is accepted)`);

const courseId = canvasId("course ID");

server.registerTool(
  "canvas_whoami",
  { description: "Check the Canvas session works. Returns the signed-in user and their time zone." },
  () => run(canvas.whoami),
);

server.registerTool(
  "canvas_login",
  {
    description:
      "Sign in to Canvas: reuses a saved session if it still works, otherwise opens a Chrome window where the user signs in themselves (waits up to 5 minutes). Other tools do this automatically when the session expires; call this only if the user asks to sign in again or switch accounts.",
    inputSchema: { force: z.boolean().default(false).describe("Open the sign-in window even if the saved session works") },
  },
  ({ force }) =>
    run(async () => {
      const s = await login({ force });
      const me = await canvas.whoami();
      return { signed_in_as: me.name, session_from: s.source };
    }),
);

server.registerTool(
  "canvas_courses",
  {
    description:
      "List the user's current courses with course_id, current score, grading type, and counts of graded/awaiting-grade assignments. Start here to get course IDs.",
    inputSchema: { all: z.boolean().default(false).describe("Also include past courses still marked active") },
  },
  ({ all }) => run(() => canvas.courses(all)),
);

server.registerTool(
  "canvas_todo",
  {
    description:
      "Upcoming items (assignments, quizzes, discussions, events, announcements) across all courses. Each has due_local (user's time zone, with weekday) and due_in; use those, not the UTC 'due' field, when telling the user when something is due.",
    inputSchema: { days: z.number().int().min(1).max(120).default(14).describe("How many days ahead to look") },
  },
  ({ days }) => run(() => canvas.todo(days)),
);

server.registerTool(
  "canvas_assignments",
  {
    description: "All assignments in one course with local due times, status (graded, missing, submitted...), and score.",
    inputSchema: {
      course_id: courseId,
      bucket: z
        .enum(["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"])
        .optional()
        .describe("Optional filter"),
    },
  },
  ({ course_id, bucket }) => run(() => canvas.assignments(toGlobalId(course_id), bucket)),
);

server.registerTool(
  "canvas_assignment",
  {
    description: "One assignment's full instructions, status, score, and the files linked in its description (with file_ids).",
    inputSchema: { course_id: courseId, assignment_id: canvasId("assignment ID") },
  },
  ({ course_id, assignment_id }) => run(() => canvas.assignment(toGlobalId(course_id), toGlobalId(assignment_id))),
);

server.registerTool(
  "canvas_grade_breakdown",
  {
    description:
      "How a course grade is built: whether Canvas weights assignment groups, each group's weight and drop rules, your score per group, and each item's approximate share of the final grade. Use for 'what's my grade made of' or 'how much is X worth'.",
    inputSchema: { course_id: courseId },
  },
  ({ course_id }) => run(() => canvas.gradeBreakdown(toGlobalId(course_id))),
);

server.registerTool(
  "canvas_announcements",
  {
    description: "Recent announcements for the given courses (defaults to all current courses), newest first.",
    inputSchema: {
      course_ids: z.array(courseId).optional(),
      days: z.number().int().min(1).max(365).default(30).describe("How many days back to look"),
    },
  },
  ({ course_ids, days }) =>
    run(async () => {
      const ids = course_ids?.length
        ? course_ids.map((id) => toGlobalId(id))
        : (await canvas.courses()).map((c) => c.course_id);
      return canvas.announcements(ids, days);
    }),
);

server.registerTool(
  "canvas_modules",
  { description: "Modules and their items for one course, with IDs for each item.", inputSchema: { course_id: courseId } },
  ({ course_id }) => run(() => canvas.modules(toGlobalId(course_id))),
);

server.registerTool(
  "canvas_files",
  {
    description:
      "Files in one course, by name. If the course hides its Files tab, falls back to files linked from its pages, modules and assignments.",
    inputSchema: { course_id: courseId, search: z.string().min(2).optional().describe("Filter by file name") },
  },
  ({ course_id, search: q }) => run(() => search.courseFiles(toGlobalId(course_id), q)),
);

server.registerTool(
  "canvas_search",
  {
    description:
      "Search one course's pages, assignments, quizzes, discussions, announcements, modules, and file names for words. Use to answer 'does X exist / where is X' (e.g. a case study, a reading, exam info). Does not search inside files.",
    inputSchema: {
      course_id: courseId,
      query: z.string().min(2),
      types: z
        .array(z.enum(["syllabus", "front_page", "page", "assignment", "quiz", "discussion", "announcement", "module", "file"]))
        .optional()
        .describe("Only search these kinds of content"),
      limit: z.number().int().min(1).max(30).default(10),
    },
  },
  ({ course_id, query, types, limit }) => run(() => search.search(toGlobalId(course_id), query, types, limit)),
);

server.registerTool(
  "canvas_syllabus",
  {
    description:
      "Find and return a course's syllabus text. Checks the Syllabus tab, then files and pages named or linked as 'syllabus' (reads PDFs).",
    inputSchema: { course_id: courseId },
  },
  ({ course_id }) => run(() => search.syllabus(toGlobalId(course_id))),
);

const fileId = canvasId("file ID");

server.registerTool(
  "canvas_read_file",
  {
    description:
      "Return the text of a Canvas file (PDF, text, HTML, CSV) without saving it. Long files are paged: pass next_offset as offset to continue.",
    inputSchema: {
      file_id: fileId,
      course_id: courseId.optional().describe("Course the file is in; needed for files linked from course content"),
      offset: z.number().int().min(0).default(0),
      max_chars: z.number().int().min(1000).max(50_000).default(20_000),
    },
  },
  ({ file_id, course_id, offset, max_chars }) =>
    run(() => canvas.readFile(toGlobalId(file_id), course_id && toGlobalId(course_id), offset, max_chars)),
);

server.registerTool(
  "canvas_download_file",
  {
    description:
      "Save a Canvas file to disk (default ~/Downloads). Never overwrites; if an identical copy already exists it returns that path with already_downloaded: true.",
    inputSchema: {
      file_id: fileId,
      course_id: courseId.optional().describe("Course the file is in; needed for files linked from course content"),
      dir: z.string().optional().describe("Absolute directory to save into"),
    },
  },
  ({ file_id, course_id, dir }) =>
    run(() => canvas.downloadFile(toGlobalId(file_id), dir, course_id && toGlobalId(course_id))),
);

// Keeps only the requested fields; "assignments.name" reaches into nested objects/arrays.
function project(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => project(v, fields));
  if (!value || typeof value !== "object") return value;
  const groups = new Map<string, string[]>();
  for (const f of fields) {
    const [head, ...rest] = f.split(".");
    if (!groups.has(head)) groups.set(head, []);
    if (rest.length) groups.get(head)!.push(rest.join("."));
  }
  const out: Record<string, unknown> = {};
  for (const [head, rest] of groups) {
    const v = (value as Record<string, unknown>)[head];
    if (v !== undefined) out[head] = rest.length ? project(v, rest) : v;
  }
  return out;
}

server.registerTool(
  "canvas_get",
  {
    description:
      "Escape hatch: GET any read-only Canvas REST endpoint (https://canvas.instructure.com/doc/api/). Prefer the dedicated tools. Responses can be huge: use `fields` to keep only what you need. Output is capped at max_chars.",
    inputSchema: {
      path: z.string().regex(/^\/api\/v1\//).describe("e.g. /api/v1/courses/123/discussion_topics"),
      params: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe("Query parameters; use arrays for repeated keys like include[]"),
      fields: z.array(z.string()).optional().describe('Keep only these fields, e.g. ["id","name","assignments.name"]'),
      all_pages: z.boolean().default(false).describe("Follow pagination (lists only)"),
      max_chars: z.number().int().min(1000).max(50_000).default(20_000),
    },
  },
  ({ path, params, fields, all_pages, max_chars }) =>
    run(async () => {
      const data = all_pages ? await canvas.getAll(path, params, 1000) : await canvas.get(path, params);
      const shaped = fields?.length ? project(data, fields) : data;
      const text = JSON.stringify(shaped);
      if (text.length <= max_chars) return shaped;
      const hint = "Response too large. Narrow it with `fields`, `params` (e.g. per_page), or a more specific path.";
      if (Array.isArray(shaped)) {
        const kept: unknown[] = [];
        let size = 0;
        for (const item of shaped) {
          size += JSON.stringify(item).length + 1;
          if (size > max_chars) break;
          kept.push(item);
        }
        return { truncated: true, returned: kept.length, total: shaped.length, hint, items: kept };
      }
      return { truncated: true, total_chars: text.length, hint, partial_json: text.slice(0, max_chars) };
    }),
);

await server.connect(new StdioServerTransport());
