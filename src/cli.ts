// Quick smoke test: node src/cli.ts <command> [args...]
import * as canvas from "./canvas.ts";
import { toGlobalId } from "./client.ts";
import * as search from "./search.ts";

const [command = "whoami", ...args] = process.argv.slice(2);
const id = (i: number) => toGlobalId(args[i]);

const commands: Record<string, () => Promise<unknown>> = {
  whoami: canvas.whoami,
  courses: () => canvas.courses(args[0] === "all"),
  todo: () => canvas.todo(args[0] ? Number(args[0]) : 14),
  assignments: () => canvas.assignments(id(0)),
  assignment: () => canvas.assignment(id(0), id(1)),
  grades: () => canvas.gradeBreakdown(id(0)),
  announcements: async () => canvas.announcements((await canvas.courses()).map((c) => c.course_id)),
  modules: () => canvas.modules(id(0)),
  files: () => search.courseFiles(id(0), args[1]),
  search: () => search.search(id(0), args.slice(1).join(" ")),
  syllabus: () => search.syllabus(id(0)),
  read: () => canvas.readFile(id(0), args[1] && toGlobalId(args[1])),
  download: () => canvas.downloadFile(id(0), undefined, args[1] && toGlobalId(args[1])),
};

if (!commands[command]) {
  console.error(`Unknown command. Try: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}

try {
  console.log(JSON.stringify(await commands[command](), null, 2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
