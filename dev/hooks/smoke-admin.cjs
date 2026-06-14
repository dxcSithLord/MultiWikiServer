#!/usr/bin/env node
/*
 * smoke-admin.cjs — headless smoke test for the HTMX admin UI.
 *
 * Boots the *built* server (dist/mws.js) against a FRESH, ISOLATED SQLite store
 * in a throwaway temp directory on an EPHEMERAL loopback port. It never touches
 * dev/wiki/store and never uses port 8080, so it cannot disturb the live service.
 *
 * It then drives Chromium (via the globally-installed puppeteer-core) to:
 *   - set a known admin password via the reset-password CLI, then log in via the
 *     HTMX OPAQUE /login form,
 *   - load /admin-htmx/users,
 *   - assert NO pageerror / console.error fired,
 *   - assert #menu-toggle-btn toggles #sidebar.mws-collapsed,
 *   - assert #user-menu-btn toggles #user-menu.mws-show,
 *   - assert a #users-tbody tr[id^="user-"] row is present and clickable.
 *
 * This guards the exact bug class seen this session: a duplicate-global JS error
 * that killed nav, and clipped/unclickable Users-table actions.
 *
 * Exit code: 0 on success, non-zero on any failure.
 *
 * Override CHROMIUM_PATH / PUPPETEER_CORE_PATH via env if the defaults move.
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist", "mws.js");

const PUPPETEER_CORE_PATH =
  process.env.PUPPETEER_CORE_PATH ||
  "/usr/local/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
// init-store now generates a unique RANDOM admin password (PSTI alignment), so the smoke
// sets its own known credential on the throwaway store via the reset-password CLI.
const SMOKE_PASSWORD = "Smoke-Test-Password-9f3k";

const log = (...a) => console.log("[smoke]", ...a);
const fail = (msg) => {
  console.error("[smoke] FAIL:", msg);
  process.exitCode = 1;
};

// --- preflight -------------------------------------------------------------
if (!fs.existsSync(DIST)) {
  console.error("[smoke] FAIL: dist/mws.js not found. Run `npm run build` first.");
  process.exit(1);
}
if (!fs.existsSync(CHROMIUM_PATH)) {
  console.error("[smoke] FAIL: chromium not found at", CHROMIUM_PATH);
  process.exit(1);
}
let puppeteer;
try {
  puppeteer = require(PUPPETEER_CORE_PATH);
} catch (e) {
  console.error("[smoke] FAIL: cannot load puppeteer-core from", PUPPETEER_CORE_PATH, "-", e.message);
  process.exit(1);
}

// Find a free ephemeral loopback port (bind to :0, read it back, release).
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Tiny ESM launcher that imports the built server with argv preset. We run it
// with cwd set to the isolated wiki dir so the store/cache land there.
function writeLauncher(wikiDir) {
  const launcher = path.join(wikiDir, "_smoke-run.mjs");
  fs.writeFileSync(
    launcher,
    [
      "// throwaway launcher for the smoke test; cwd == wiki dir",
      `import("${DIST.replace(/\\/g, "\\\\")}").then(m => m.default()).catch(e => { console.error(e); process.exit(1); });`,
      "",
    ].join("\n")
  );
  return launcher;
}

function runMws(launcher, wikiDir, args) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [launcher, ...args], {
      cwd: wikiDir,
      env: {
        ...process.env,
        ENABLE_DEV_SERVER: "mws",
        ENABLE_EXTERNAL_PLUGINS: "1",
        DEBUG: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    resolve(cp);
    cp.on("error", reject);
  });
}

function waitForListening(cp, port, timeoutMs) {
  // Poll the port until something accepts a connection, or the child exits.
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let done = false;
    cp.on("exit", (code) => {
      if (!done) reject(new Error("server exited early with code " + code));
    });
    const tick = () => {
      if (done) return;
      if (Date.now() > deadline) {
        done = true;
        return reject(new Error("server did not start listening within " + timeoutMs + "ms"));
      }
      const sock = net.connect(port, "127.0.0.1");
      sock.on("connect", () => {
        sock.destroy();
        done = true;
        resolve();
      });
      sock.on("error", () => {
        sock.destroy();
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function toggleWorks(page, btnSel, targetId, cls) {
  const read = (id, c) =>
    page.evaluate(
      (i, k) => {
        const el = document.getElementById(i);
        return !!(el && el.classList.contains(k));
      },
      targetId,
      cls
    );
  const before = await read(targetId, cls);
  await page.click(btnSel);
  await new Promise((r) => setTimeout(r, 200));
  const after = await read(targetId, cls);
  return before !== after;
}

(async () => {
  const wikiDir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-smoke-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const launcher = writeLauncher(wikiDir);
  let server = null;
  let browser = null;

  const cleanup = () => {
    try {
      if (browser) browser.close();
    } catch (_) {}
    try {
      if (server && !server.killed) server.kill("SIGTERM");
    } catch (_) {}
    try {
      fs.rmSync(wikiDir, { recursive: true, force: true });
    } catch (_) {}
  };
  process.on("exit", cleanup);

  try {
    log("isolated wiki dir:", wikiDir);
    log("ephemeral port:", port);

    // 1. Initialise a fresh store (creates the admin user with a random password).
    log("initialising fresh store (init-store)...");
    await new Promise((resolve, reject) => {
      const init = spawn(process.execPath, [launcher, "init-store"], {
        cwd: wikiDir,
        env: { ...process.env, ENABLE_DEV_SERVER: "mws", ENABLE_EXTERNAL_PLUGINS: "1", DEBUG: "" },
        stdio: ["ignore", "ignore", "inherit"],
      });
      init.on("error", reject);
      init.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("init-store exited with code " + code))
      );
    });

    // 1b. Set a deterministic admin password on this throwaway store via the reset-password
    //     CLI (init-store now generates a unique random password per the PSTI alignment, so
    //     the smoke can't assume a fixed default).
    log("setting smoke admin password (reset-password)...");
    await new Promise((resolve, reject) => {
      const rp = spawn(process.execPath, [launcher, "reset-password", "admin", SMOKE_PASSWORD], {
        cwd: wikiDir,
        env: { ...process.env, ENABLE_DEV_SERVER: "mws", ENABLE_EXTERNAL_PLUGINS: "1", DEBUG: "" },
        stdio: ["ignore", "ignore", "inherit"],
      });
      rp.on("error", reject);
      rp.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("reset-password exited with code " + code))
      );
    });

    // 2. Boot the server on the ephemeral loopback port.
    log("starting server...");
    server = await runMws(launcher, wikiDir, [
      "listen",
      "--listener",
      "host=127.0.0.1",
      `port=${port}`,
    ]);
    server.stdout.on("data", () => {});
    server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
    await waitForListening(server, port, 30000);
    log("server is listening at", base);

    // 3. Drive the browser.
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const errors = [];
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      // Ignore browser-emitted resource-load 404s (e.g. the favicon the browser
      // auto-requests at $:/favicon.ico). Those are not application JS errors and
      // are not the bug class this smoke guards (a thrown JS error that kills nav,
      // which surfaces as a `pageerror` below, not a resource 404).
      if (/Failed to load resource:.*404/.test(text)) return;
      errors.push("console.error: " + text);
    });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

    // Login via the HTMX OPAQUE form.
    log("logging in as admin...");
    await page.goto(base + "/login", { waitUntil: "networkidle0" });
    await page.type("#username", "admin");
    await page.type("#password", SMOKE_PASSWORD);
    await page.click("#login-submit");
    await page
      .waitForFunction(() => location.pathname.includes("/admin-htmx"), { timeout: 15000 })
      .catch(() => {});

    // Load the Users page.
    log("loading /admin-htmx/users...");
    await page.goto(base + "/admin-htmx/users", { waitUntil: "networkidle0" });
    const rowSel = '#users-tbody tr[id^="user-"]';
    const haveRow = await page
      .waitForSelector(rowSel, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    // --- assertions --------------------------------------------------------
    if (errors.length) fail("page produced JS errors:\n  " + errors.join("\n  "));

    const hamburger = await toggleWorks(page, "#menu-toggle-btn", "sidebar", "mws-collapsed");
    if (!hamburger) fail("#menu-toggle-btn did NOT toggle #sidebar.mws-collapsed");
    // restore sidebar state
    await page.click("#menu-toggle-btn").catch(() => {});

    const dropdown = await toggleWorks(page, "#user-menu-btn", "user-menu", "mws-show");
    if (!dropdown) fail("#user-menu-btn did NOT toggle #user-menu.mws-show");
    await page.click("#user-menu-btn").catch(() => {}); // close

    if (!haveRow) {
      fail("no " + rowSel + " row found in the Users table");
    } else {
      // Assert the row is clickable: present, in-viewport, and click does not throw.
      const clickable = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
      }, rowSel);
      if (!clickable) fail(rowSel + " is present but not clickable/in-viewport");
      await page.click(rowSel).catch((e) => fail("clicking " + rowSel + " threw: " + e.message));
    }

    // Late-arriving errors (e.g. from the row click) also fail the run.
    await new Promise((r) => setTimeout(r, 300));
    if (errors.length && process.exitCode !== 1) {
      fail("page produced JS errors:\n  " + errors.join("\n  "));
    }

    if (process.exitCode === 1) {
      log("smoke test FAILED");
    } else {
      log("smoke test PASSED");
    }
  } catch (e) {
    fail((e && e.message) || String(e));
  } finally {
    cleanup();
    // Give cleanup a tick; exitCode is already set.
    process.exit(process.exitCode || 0);
  }
})();
