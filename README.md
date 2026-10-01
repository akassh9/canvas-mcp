# canvas-mcp

Read-only Canvas (canvas.wustl.edu) API client and MCP server. It signs in with your browser
session cookie, because WashU doesn't let students create personal access tokens.

## Set up the cookie

1. Sign in to Canvas in Chrome and open DevTools → **Network**, filtered to **Fetch/XHR**.
2. Reload the dashboard and click any request whose path starts with `/api/v1/`.
3. Under **Headers → Request Headers**, right-click `cookie` → **Copy value**.
4. Paste it between the quotes in `.env`: `CANVAS_COOKIE='...'`

The cookie is your login. Keep it out of chats, commits and screenshots. When it expires,
the tools say so; repeat the steps above.

## Try it

```bash
npm run cli whoami
npm run cli courses
npm run cli todo 7
npm run cli grades <course_id>
npm run cli search <course_id> practice midterm
npm run cli syllabus <course_id>
```

Course and file IDs can be given in either Canvas format (`60780000000180256` or `6078~180256`).

## Use as an MCP server

```bash
claude mcp add canvas -s user -- node /Users/akashkhanikor/canvas-mcp/src/mcp.ts
```

| Tool | What it does |
|---|---|
| `canvas_courses` | Current courses: IDs, score, grading type, graded/awaiting counts |
| `canvas_todo` | Upcoming items with local due times (`due_local`, `due_in`) |
| `canvas_assignments` / `canvas_assignment` | Assignments, status, instructions, linked files |
| `canvas_grade_breakdown` | Group weights, drop rules, per-group scores, each item's share of the grade |
| `canvas_announcements`, `canvas_modules` | What they say |
| `canvas_search` | Search a course's pages, assignments, quizzes, discussions, announcements, file names |
| `canvas_syllabus` | Finds the syllabus (tab, page, or linked PDF) and returns its text |
| `canvas_files` | Files tab, or files linked from course content when the tab is hidden |
| `canvas_read_file` | Text of a PDF/text/HTML file without saving it (PDFs need `brew install poppler`) |
| `canvas_download_file` | Save to ~/Downloads; reuses an identical existing copy |
| `canvas_get` | Any read-only `/api/v1/...` path, with `fields` filtering and a size cap |
| `canvas_whoami` | Session check |

Notes:
- All IDs in output use the long global form. Dates come with `*_local` (your Canvas time zone) and `*_in`.
- Search results are cached for 10 minutes per course within a session.
