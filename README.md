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
npm run cli assignments <course_id>
```

## Use as an MCP server

```bash
claude mcp add canvas -- node /Users/akashkhanikor/canvas-mcp/src/mcp.ts
```

Tools: `canvas_whoami`, `canvas_courses`, `canvas_todo`, `canvas_assignments`,
`canvas_assignment` (instructions + linked files), `canvas_announcements`, `canvas_modules`,
`canvas_files`, `canvas_download_file` (saves to ~/Downloads, never overwrites), and
`canvas_get` (any read-only `/api/v1/...` path).
