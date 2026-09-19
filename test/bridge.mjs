/**
 * Runs the bridge's message handlers, rather than only checking the file parses.
 *
 * This exists because of a bug nothing else caught. `bridge.js` called `connection()` without
 * importing it — `node --check` passed, the extension loaded cleanly in Chrome, and every listener
 * attached. It failed only when a handler actually ran, as an uncaught ReferenceError in the service
 * worker, by which point the app had already said "connecting…".
 *
 * A syntax check proves a file parses. A load check proves it registers. Neither proves it *works*,
 * and the gap between the second and the third is where a missing import lives.
 *
 * The chrome API is stubbed rather than mocked-with-a-library: what these handlers touch is a handful
 * of storage calls and one fetch, and a stub that records them says more about the contract than an
 * assertion framework would.
 */
import { chromium } from "playwright";
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, normalize } from "node:path";

/**
 * The extension's own files, served over http so the browser can `import` them for real.
 *
 * Concatenating the modules and stripping their import lines was the first attempt, and it was
 * worthless: it put both files in one scope, so the missing import this test exists for became
 * invisible. Real module resolution is the only thing that proves an import is actually there.
 */
const root = new URL("..", import.meta.url).pathname;
const server = http.createServer((req, res) => {
  const path = normalize(root + decodeURIComponent(req.url.split("?")[0]));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try {
    res.writeHead(200, {
      "content-type": extname(path) === ".js" ? "text/javascript" : "text/html",
    });
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

// An empty page on the same origin as the extension's files, so they can be imported as modules.
// Written here rather than committed: it is scaffolding for this file and nothing else reads it.
writeFileSync(
  new URL("./.bridge-host.html", import.meta.url),
  "<!doctype html><title>bridge host</title>\n"
);

const browser = await chromium.launch();
const page = await browser.newPage();
let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${
      ok ? "" : `\n         got ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`
    }`
  );
}

await page.goto(origin + "/test/.bridge-host.html");

/**
 * Run a bridge handler in the page, against a stubbed chrome and fetch.
 *
 * `bridge.js` is imported as a module, so its own `import` statements are resolved by the browser —
 * which is the entire point. A borrowed identifier that nobody imported is a ReferenceError here,
 * exactly as it is in the service worker.
 */
async function run({ storage = {}, local = {}, message, meStatus = 200 }) {
  return page.evaluate(
    async ([base, sync, loc, msg, status]) => {
      const calls = { set: [], fetched: [] };
      const sync_ = { ...sync };
      const local_ = { ...loc };

      globalThis.chrome = {
        runtime: {
          onMessageExternal: { addListener: (fn) => (globalThis.__external = fn) },
          onConnectExternal: { addListener: () => {} },
          getManifest: () => ({ version: "0.1.0" }),
          openOptionsPage: async () => {},
        },
        storage: {
          sync: {
            get: async (keys) =>
              Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).map((k) => [k, sync_[k]])
              ),
            set: async (v) => {
              calls.set.push(v);
              Object.assign(sync_, v);
            },
          },
          local: {
            get: async (keys) =>
              Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).map((k) => [k, local_[k]])
              ),
            set: async (v) => {
              calls.set.push(v);
              Object.assign(local_, v);
            },
          },
        },
      };
      // An async handler that throws rejects a promise nobody awaits, so the error would otherwise
      // vanish and the case would look like a timeout with no cause.
      globalThis.addEventListener("unhandledrejection", (e) => {
        globalThis.__lastError = String(e.reason);
      });

      globalThis.fetch = async (url) => {
        calls.fetched.push(String(url));
        return { ok: status === 200, status, json: async () => ({ id: "u1" }) };
      };

      // Cache-busted so each case gets a module instance with fresh listeners.
      const { openBridge } = await import(
        `${base}/src/background/bridge.js?case=${Math.random()}`
      );

      openBridge({
        state: async () => ({ type: "state", running: false }),
        version: "0.1.0",
        start: async (platform) => ({ ok: true, started: true, platform }),
      });

      // A handler that throws never calls `respond`, so the promise would simply never settle and
      // Playwright would report a garbage-collected promise — true, and useless. Racing a timeout
      // and catching the throw turns "it broke" into "it broke here, like this", which is the whole
      // difference between a test that fails and a test that helps.
      const reply = await Promise.race([
        new Promise((resolve) => {
          try {
            const kept = globalThis.__external(msg, {}, resolve);
            if (kept !== true) resolve({ __unhandled: true });
          } catch (err) {
            resolve({ __threw: String(err) });
          }
        }),
        new Promise((resolve) =>
          setTimeout(() => resolve({ __neverAnswered: true, lastError: globalThis.__lastError }), 3000)
        ),
      ]);
      return { reply, calls };
    },
    [origin, storage, local, message, meStatus]
  );
}

console.log("bridge handlers actually run:");

{
  const { reply } = await run({ message: { type: "ping" } });
  check("ping answers", reply.ok, true);
}

{
  // The case that broke: sync reaches for `connection()`, which lives in api.js.
  const { reply } = await run({ message: { type: "sync", platform: "upwork" } });
  check("sync with no token refuses rather than throwing", reply.reason, "needs_token");
}

{
  const { reply, calls } = await run({
    storage: { apiUrl: "http://localhost:8010", token: "tok" },
    local: { "connection.owner": "u1" },
    message: { type: "sync", platform: "upwork", userId: "u1" },
  });
  check("sync with a good token starts a run", [reply.ok, reply.started], [true, true]);
  check("and it checked the credential first", calls.fetched[0].endsWith("/accounts/me"), true);
}

{
  // The multi-user hole: a token belonging to someone else must not run.
  const { reply } = await run({
    storage: { apiUrl: "http://localhost:8010", token: "tok" },
    local: { "connection.owner": "someone-else" },
    message: { type: "sync", platform: "upwork", userId: "u1" },
  });
  check("a token for another user is refused", reply.reason, "different_user");
}

{
  const { reply } = await run({
    storage: { apiUrl: "http://localhost:8010", token: "tok" },
    local: { "connection.owner": "u1" },
    message: { type: "sync", platform: "upwork", userId: "u1" },
    meStatus: 401,
  });
  check("a revoked token says so", reply.reason, "revoked");
}

{
  const { reply, calls } = await run({
    message: {
      type: "connect",
      apiUrl: "http://localhost:8010",
      token: "tok",
      userId: "u1",
      appUrl: "http://localhost:3000",
      settings: { useLlm: true, nonsense: 1 },
    },
  });
  check("connect stores the credential", reply.ok, true);
  const stored = Object.assign({}, ...calls.set);
  check("records whose token it is", stored["connection.owner"], "u1");
  check("and where the app lives", stored["connection.app"], "http://localhost:3000");
  // An allowlist, so a future field in the app cannot quietly write something nothing reads.
  check("unknown settings keys are dropped", stored["collect.settings"], { useLlm: true });
}

{
  const { reply } = await run({ message: { type: "connect", apiUrl: "http://x", token: "" } });
  check("connect without a token is refused", reply.ok, false);
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} failing` : "\nall bridge handlers work");
process.exit(failures ? 1 : 0);
