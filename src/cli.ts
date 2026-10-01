// Quick smoke test: node src/cli.ts <command> [args...]
import * as canvas from "./canvas.ts";
import { login, logout } from "./client.ts";
import * as search from "./search.ts";

const [command = "whoami", ...args] = process.argv.slice(2);
const id = (i: number) => args[i];

const commands: Record<string, () => Promise<unknown>> = {
  login: async () => {
    console.error("Checking for a saved Canvas session...");
    const s = await login({
      // Always go through the browser so the login profile (SSO, Duo) is set up for silent refreshes.
      force: true,
      onWindow: () => console.error("Opening a Chrome window: sign in to Canvas there (SSO and Duo as usual)."),
      log: (msg) => console.error(msg),
    });
    const me = await canvas.whoami();
    return {
      signed_in_as: me.name,
      saved_to: s.source === "login" ? (process.platform === "darwin" ? "~/.canvas-mcp (encrypted; key in macOS Keychain)" : "~/.canvas-mcp") : s.source,
    };
  },
  logout: async () => {
    await logout();
    return { signed_out: true, note: "Removed the saved session and the login browser profile." };
  },
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
  read: () => canvas.readFile(id(0), args[1]),
  download: () => canvas.downloadFile(id(0), undefined, args[1]),
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
