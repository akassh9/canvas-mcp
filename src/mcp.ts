import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as canvas from "./canvas.ts";

const server = new McpServer({ name: "canvas", version: "0.1.0" });

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return result(await fn());
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
  }
}

const courseId = z.coerce.string().regex(/^\d+$/).describe("Canvas course ID (from canvas_courses)");

server.registerTool(
  "canvas_whoami",
  { description: "Check the Canvas session works and return the signed-in user." },
  () => run(canvas.whoami),
);

server.registerTool(
  "canvas_courses",
  {
    description: "List courses with their IDs, term, and current overall score/grade. Defaults to current (dashboard) courses.",
    inputSchema: { all: z.boolean().default(false).describe("Include past courses still marked active") },
  },
  ({ all }) => run(() => canvas.courses(all)),
);

server.registerTool(
  "canvas_todo",
  {
    description: "Upcoming planner items (assignments, quizzes, discussions, events) across all courses, with submission status.",
    inputSchema: { days: z.number().int().min(1).max(120).default(14).describe("How many days ahead to look") },
  },
  ({ days }) => run(() => canvas.todo(days)),
);

server.registerTool(
  "canvas_assignments",
  {
    description: "Assignments for one course, with due dates and your score/submission state.",
    inputSchema: {
      course_id: courseId,
      bucket: z
        .enum(["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"])
        .optional()
        .describe("Optional filter"),
    },
  },
  ({ course_id, bucket }) => run(() => canvas.assignments(course_id, bucket)),
);

server.registerTool(
  "canvas_announcements",
  {
    description: "Recent announcements for the given courses (defaults to all active courses).",
    inputSchema: {
      course_ids: z.array(z.coerce.string()).optional(),
      days: z.number().int().min(1).max(365).default(30).describe("How many days back to look"),
    },
  },
  ({ course_ids, days }) =>
    run(async () => {
      const ids = course_ids?.length ? course_ids : (await canvas.courses()).map((c) => c.id);
      return canvas.announcements(ids, days);
    }),
);

server.registerTool(
  "canvas_modules",
  { description: "Modules and their items for one course.", inputSchema: { course_id: courseId } },
  ({ course_id }) => run(() => canvas.modules(course_id)),
);

server.registerTool(
  "canvas_files",
  {
    description: "Files in one course, newest first. Some courses hide the Files tab from students; that returns an error.",
    inputSchema: { course_id: courseId, search: z.string().min(2).optional() },
  },
  ({ course_id, search }) => run(() => canvas.files(course_id, search)),
);

server.registerTool(
  "canvas_get",
  {
    description:
      "Escape hatch: GET any Canvas REST endpoint (read-only). See https://canvas.instructure.com/doc/api/ for paths.",
    inputSchema: {
      path: z.string().regex(/^\/api\/v1\//).describe("e.g. /api/v1/courses/123/discussion_topics"),
      params: z.record(z.string(), z.string()).optional().describe("Query parameters"),
    },
  },
  ({ path, params }) => run(() => canvas.get(path, params)),
);

await server.connect(new StdioServerTransport());
