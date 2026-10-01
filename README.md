# canvas-mcp

Read-only Canvas LMS API client and MCP server, built against WashU's Canvas at
wustl.instructure.com (set `CANVAS_BASE_URL` in `.env` for another school). It signs in with your browser session cookie,
because WashU doesn't let students create personal access tokens.

## Sign in

```bash
npm install
npm run login
```

A Chrome window opens on Canvas. Sign in as usual (SSO, Duo); the window closes by itself and
the session is saved in `~/.canvas-mcp`, encrypted with a key kept in the macOS Keychain (a plain
`0600` file on other systems).

When the session expires, the server refreshes it automatically. The login window keeps its own
profile in `~/.canvas-mcp/browser-profile-<host>`, so this usually happens silently in the background.
If Canvas needs you to sign in again, a Chrome window opens and the tool waits up to 90 seconds
for you before asking you to retry.

- `npm run logout` removes the saved session and the login browser profile.
- `CANVAS_AUTO_LOGIN=0` turns off automatic login windows; `CANVAS_LOGIN_WAIT_MS` changes the wait.
- Manual fallback: paste a `cookie` request header from DevTools into `.env` as `CANVAS_COOKIE='...'`.
  The saved session takes priority when both exist.

The session is your login. Keep it out of chats, commits and screenshots.

## Try it

```bash
npm run cli whoami
npm run cli courses
npm run cli todo 7
npm run cli grades <course_id>
npm run cli search <course_id> practice midterm
npm run cli syllabus <course_id>
```

Course and file IDs can be given in any Canvas format (`180256`, `6078~180256` or `60780000000180256`).

## Use as an MCP server

```bash
claude mcp add canvas -s user -- node "$(pwd)/src/mcp.ts"   # run from the repo folder
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
| `canvas_whoami` | Session check (and where the session came from) |
| `canvas_login` | Re-run sign-in on request (expiry is handled automatically) |

Notes:
- IDs are passed through as Canvas returns them. Dates come with `*_local` (your Canvas time zone) and `*_in`.
- Search results are cached for 10 minutes per course within a session.
