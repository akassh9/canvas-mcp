// Canvas session storage and browser login.
//
// `login` opens a Chrome window on a dedicated profile; the user signs in normally (SSO, Duo)
// and we capture the Canvas cookies once the API accepts them. The profile keeps the SSO
// session, so later refreshes usually finish headlessly without showing a window.

import { execFile, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DIR = join(homedir(), ".canvas-mcp");
const LOCK_FILE = join(DIR, "login.lock");
const KEYCHAIN_SERVICE = "canvas-mcp";

export type Session = { cookie: string; source: "saved" | ".env" | "login" };

// ---- Storage ----

// Two secrets per Canvas host: the Canvas cookie header, and the login browser's cookies
// (SSO, Duo "remember me"). Chrome drops session cookies when it closes, so we keep them
// ourselves; restoring them is what lets a later refresh finish without the user.
//
// On macOS each secret is an AES-256-GCM encrypted file whose key lives in the Keychain.
// (Storing the values in the Keychain directly doesn't work: `security -i` garbles long
// values, and passing them as arguments would expose them in the process list.)
// Elsewhere it's a plain 0600 file.
type Secret = "session" | "browser";

const ENCRYPT = process.platform === "darwin";

function host(baseUrl: string): string {
  return new URL(baseUrl).host;
}

function secretFile(baseUrl: string, kind: Secret): string {
  return join(DIR, `${kind}-${host(baseUrl)}.${ENCRYPT ? "enc" : "txt"}`);
}

async function security(args: string[]): Promise<string> {
  return (await execFileAsync("security", args, { maxBuffer: 1024 * 1024 })).stdout.trim();
}

// Runs one command through `security -i` so its arguments stay out of the process list.
function securityStdin(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 && !err.trim() ? resolve() : reject(new Error(`Keychain error: ${err.trim()}`))));
    child.stdin.end(`${command}\n`);
  });
}

// 32-byte file key kept in the Keychain, created on first use.
async function fileKey(baseUrl: string, create: boolean): Promise<Buffer | undefined> {
  const acct = `${host(baseUrl)}#key`;
  try {
    const hex = await security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", acct, "-w"]);
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  } catch {
    // Not created yet.
  }
  if (!create) return undefined;
  const key = randomBytes(32);
  await securityStdin(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${acct} -w ${key.toString("hex")}`);
  return key;
}

async function loadSecret(baseUrl: string, kind: Secret): Promise<string | undefined> {
  let data: string;
  try {
    data = (await readFile(secretFile(baseUrl, kind), "utf8")).trim();
  } catch {
    return kind === "session" && ENCRYPT ? loadLegacyKeychainSession(baseUrl) : undefined;
  }
  if (!ENCRYPT) return data || undefined;
  try {
    const key = await fileKey(baseUrl, false);
    if (!key) return undefined;
    const raw = Buffer.from(data, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return undefined; // Wrong key or corrupted file: treat as missing.
  }
}

async function saveSecret(baseUrl: string, kind: Secret, value: string): Promise<void> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  let data = value;
  if (ENCRYPT) {
    const key = (await fileKey(baseUrl, true))!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    data = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  await writeFile(secretFile(baseUrl, kind), data, { mode: 0o600 });
}

async function deleteSecret(baseUrl: string, kind: Secret): Promise<void> {
  await rm(secretFile(baseUrl, kind), { force: true });
}

// Early versions kept the session cookie directly in the Keychain; still read it once.
async function loadLegacyKeychainSession(baseUrl: string): Promise<string | undefined> {
  try {
    const out = await security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", host(baseUrl), "-w"]);
    return /^(?:[0-9a-f]{2})+$/.test(out) ? Buffer.from(out, "hex").toString("utf8") : out || undefined;
  } catch {
    return undefined;
  }
}

export async function loadStored(baseUrl: string): Promise<Session | undefined> {
  const cookie = await loadSecret(baseUrl, "session");
  return cookie ? { cookie, source: "saved" } : undefined;
}

export function saveStored(baseUrl: string, cookie: string): Promise<void> {
  return saveSecret(baseUrl, "session", cookie);
}

export function clearStored(baseUrl: string): Promise<void> {
  return deleteSecret(baseUrl, "session");
}

// Forget everything, so the next login asks for SSO again.
export async function logout(baseUrl: string): Promise<void> {
  await deleteSecret(baseUrl, "session");
  await deleteSecret(baseUrl, "browser");
  if (ENCRYPT) {
    for (const acct of [host(baseUrl), `${host(baseUrl)}#browser`, `${host(baseUrl)}#key`]) {
      await security(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", acct]).catch(() => {});
    }
  }
  await rm(profileDir(baseUrl), { recursive: true, force: true });
}

// ---- Validation ----

// HTTP status of a cheap authenticated call (0 on network error).
async function apiStatus(baseUrl: string, cookie: string): Promise<number> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/users/self`, {
      headers: { Cookie: cookie, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
      redirect: "manual",
    });
    await res.body?.cancel();
    return res.status;
  } catch {
    return 0;
  }
}

export async function isValid(baseUrl: string, cookie: string): Promise<boolean> {
  return (await apiStatus(baseUrl, cookie)) === 200;
}

// ---- Browser login ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One profile per Canvas host, so nothing done for one host (or a test) touches another.
function profileDir(baseUrl: string): string {
  return join(DIR, `browser-profile-${new URL(baseUrl).host}`);
}

async function launch(baseUrl: string, headless: boolean) {
  const { chromium } = await import("playwright-core");
  await mkdir(profileDir(baseUrl), { recursive: true, mode: 0o700 });
  // Keep Chrome's sandbox on (Playwright disables it by default): the user signs in to real accounts here.
  const options = {
    headless,
    viewport: null,
    chromiumSandbox: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  };
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launchPersistentContext(profileDir(baseUrl), { ...options, channel });
    } catch (err) {
      if (/ProcessSingleton|SingletonLock|already in use/i.test(String(err))) {
        throw new Error("The Canvas login window is already open. Finish signing in there.");
      }
    }
  }
  throw new Error("Couldn't start Chrome or Edge for Canvas login. Install Google Chrome and try again.");
}

function where(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

// Opens Canvas and resolves with a cookie header once the API accepts it. Success is judged
// only by the Canvas cookies working, not by which page or tab the user ends up on, since SSO
// can pass through interstitial pages or open new tabs.
async function browserLogin(baseUrl: string, headless: boolean, timeoutMs: number, log?: (msg: string) => void) {
  const context = await launch(baseUrl, headless);
  try {
    const saved = await loadSecret(baseUrl, "browser");
    if (saved) {
      const now = Date.now() / 1000;
      const cookies = (JSON.parse(saved) as any[]).filter((c) => c.expires === -1 || c.expires > now);
      await context.addCookies(cookies).catch(() => {});
    }
    const first = context.pages()[0] ?? (await context.newPage());
    await first.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    let lastTried = "";
    let lastCheck = 0;
    let lastStatus = 0;
    let lastLog = Date.now();
    let detours = 0;
    while (Date.now() < deadline) {
      const pages = context.pages();
      if (pages.length === 0) throw new Error("The Canvas login window was closed before sign-in finished.");

      const cookies = await context.cookies(baseUrl);
      const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      // Check whenever the cookies change, and every few seconds anyway in case a check failed.
      if (header && (header !== lastTried || Date.now() - lastCheck > 6000)) {
        lastTried = header;
        lastCheck = Date.now();
        lastStatus = await apiStatus(baseUrl, header);
        if (lastStatus === 200) {
          await saveSecret(baseUrl, "browser", JSON.stringify(await context.cookies())).catch(() => {});
          return header;
        }
      }

      // WashU's SSO sometimes lands on a "No Canvas Account Found" page whose fix is a plain
      // link back to Canvas. Follow it, as the user would, a couple of times at most.
      const stuck = pages.find((p) => /no-canvas-account-found/.test(p.url()));
      if (stuck && detours < 2) {
        detours++;
        log?.("Canvas sent the window to its \"No Canvas Account Found\" page; continuing to Canvas.");
        await stuck.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
      }

      if (log && Date.now() - lastLog > 15_000) {
        lastLog = Date.now();
        const names = cookies.map((c) => c.name).join(", ") || "none";
        log(
          `Still waiting for Canvas sign-in. Window is on: ${pages.map((p) => where(p.url())).join(", ")}. ` +
            `Canvas cookies: ${names}. API check: ${lastStatus || "not tried"}.`,
        );
      }
      await sleep(1500);
    }
    throw new Error(headless ? "Silent refresh didn't finish." : "Timed out waiting for Canvas sign-in.");
  } finally {
    await context.close().catch(() => {});
  }
}

// ---- Cross-process lock, so several MCP servers don't all open login windows ----

async function lockHolder(): Promise<number | undefined> {
  try {
    const { pid, at } = JSON.parse(await readFile(LOCK_FILE, "utf8"));
    if (pid !== process.pid && Date.now() - at < 10 * 60_000) {
      process.kill(pid, 0); // throws if that process is gone
      return pid;
    }
  } catch {
    // No lock, unreadable lock, or stale holder.
  }
  return undefined;
}

async function acquireLock(): Promise<boolean> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  if (await lockHolder()) return false;
  await writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return true;
}

async function releaseLock(): Promise<void> {
  try {
    const { pid } = JSON.parse(await readFile(LOCK_FILE, "utf8"));
    if (pid === process.pid) await unlink(LOCK_FILE);
  } catch {
    // Already gone.
  }
}

// ---- Public: get a working session, logging in if needed ----

export type RefreshOptions = {
  // Skip reusing stored/.env cookies and go straight to the browser.
  force?: boolean;
  // Max time to wait for the user to finish signing in.
  timeoutMs?: number;
  // Cookies already known to be bad, so they aren't retried.
  rejected?: string;
  envCookie?: string;
  onWindow?: () => void;
  // Progress messages while waiting on the login window (CLI only).
  log?: (msg: string) => void;
};

let inflight: Promise<Session> | undefined;

// Single-flight within this process: concurrent callers share one login.
export function refreshSession(baseUrl: string, opts: RefreshOptions = {}): Promise<Session> {
  inflight ??= doRefresh(baseUrl, opts).finally(() => (inflight = undefined));
  return inflight;
}

async function doRefresh(baseUrl: string, opts: RefreshOptions): Promise<Session> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  // Another process may already have logged in, or the user may have updated .env.
  if (!opts.force) {
    const candidates: Session[] = [];
    const stored = await loadStored(baseUrl);
    if (stored) candidates.push(stored);
    if (opts.envCookie) candidates.push({ cookie: opts.envCookie, source: ".env" });
    for (const c of candidates) {
      if (c.cookie !== opts.rejected && (await isValid(baseUrl, c.cookie))) return c;
    }
  }

  if (!(await acquireLock())) {
    // Someone else is showing the login window; wait for their result.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(2000);
      const stored = await loadStored(baseUrl);
      if (stored && stored.cookie !== opts.rejected && (await isValid(baseUrl, stored.cookie))) return stored;
      if (!(await lockHolder())) break;
    }
    if (!(await acquireLock())) throw new Error("Timed out waiting for Canvas sign-in in another window.");
  }

  try {
    let cookie: string | undefined;
    try {
      // A still-valid SSO session redirects back to Canvas within a few seconds.
      cookie = await browserLogin(baseUrl, true, 12_000);
    } catch {
      opts.onWindow?.();
      cookie = await browserLogin(baseUrl, false, timeoutMs, opts.log);
    }
    await saveStored(baseUrl, cookie);
    return { cookie, source: "login" };
  } finally {
    await releaseLock();
  }
}
