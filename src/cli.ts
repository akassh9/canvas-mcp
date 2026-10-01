// Quick smoke test: node src/cli.ts <command> [arg]
import * as canvas from "./canvas.ts";

const [command = "whoami", arg] = process.argv.slice(2);

const commands: Record<string, () => Promise<unknown>> = {
  whoami: canvas.whoami,
  courses: () => canvas.courses(arg === "all"),
  todo: () => canvas.todo(arg ? Number(arg) : 14),
  assignments: () => canvas.assignments(arg),
  modules: () => canvas.modules(arg),
  files: () => canvas.files(arg),
  announcements: async () => canvas.announcements((await canvas.courses()).map((c) => c.id)),
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
