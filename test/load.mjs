/**
 * Loads the real extension into a real Chromium and reports whether it came up clean.
 *
 * `run.mjs` proves the readers parse a page. This proves the thing containing them actually loads —
 * which no amount of unit testing can, because a malformed manifest, a service worker that throws on
 * its first tick, and an unresolvable import all present the same way: the extension is simply dead,
 * with the reason buried in chrome://extensions where nobody looks until they are already confused.
 *
 * The permission table at the end is the important part. It asks *Chrome* whether each host may be
 * read and compares that against what the code claims to support. Those two disagreeing is what
 * produced "Cannot access contents of url ... must request permission to access this host" — after the
 * popup had already offered to read the page, which is the worst moment to discover it. Nothing else
 * in the suite can answer that question, because only Chrome knows the answer.
 */
import { chromium } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXT = process.argv[2] ?? new URL("..", import.meta.url).pathname;
const profile = mkdtempSync(join(tmpdir(), "al-ext-"));
const problems = [];

const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

context.on("weberror", (e) => problems.push(`page error: ${e.error().message}`));

// The MV3 service worker registers asynchronously after load.
let worker = context.serviceWorkers()[0];
if (!worker) {
  worker = await context.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => null);
}

if (!worker) {
  console.log("FAIL  the service worker never registered — the extension did not load");
  await context.close();
  process.exit(1);
}

console.log("PASS  service worker registered");
console.log("      " + worker.url().replace(/^chrome-extension:\/\/[a-z]+\//, ".../"));

// Read the manifest back through the extension's own API: proves Chrome parsed and accepted it,
// rather than that the JSON merely happens to be valid.
const seen = await worker.evaluate(() => {
  const m = chrome.runtime.getManifest();
  return {
    version: m.version,
    hosts: m.host_permissions,
    external: m.externally_connectable?.matches ?? [],
    hasBridge: typeof chrome.runtime.onConnectExternal?.addListener === "function",
  };
});

console.log(`PASS  manifest accepted by Chrome (v${seen.version})`);
console.log("      host_permissions: " + seen.hosts.length + " entries");
for (const h of seen.hosts) console.log("        " + h);
console.log("      externally_connectable: " + seen.external.join(", "));
console.log(
  (seen.hasBridge ? "PASS" : "FAIL") + "  onConnectExternal available (the app can open a port)"
);

// The listeners the popup and the app rely on. A worker that threw before registering them would
// still look "registered" but answer nothing.
const listening = await worker.evaluate(() => ({
  message: chrome.runtime.onMessage.hasListeners(),
  external: chrome.runtime.onMessageExternal.hasListeners(),
  connect: chrome.runtime.onConnectExternal.hasListeners(),
}));
for (const [name, ok] of Object.entries(listening)) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} listener attached`);
  if (!ok) problems.push(`${name} listener missing`);
}

// Does the collector's own tab query run, and does Chrome accept the origin patterns?
const queried = await worker.evaluate(async () => {
  try {
    await chrome.tabs.query({ url: ["https://www.upwork.com/*", "https://upwork.com/*"] });
    return "ok";
  } catch (e) {
    return String(e.message || e);
  }
});
console.log((queried === "ok" ? "PASS" : "FAIL") + `  tabs.query accepts the declared origins`);
if (queried !== "ok") problems.push(`tabs.query: ${queried}`);

// The definitive check on the bug that was fixed: ask Chrome itself whether we may read each host,
// and compare that against what the code claims to support. These two disagreeing is what produced
// "Cannot access contents of url" *after* the popup had already offered to read the page.
const HOSTS = [
  "www.upwork.com", "upwork.com", "community.upwork.com", "support.upwork.com",
  "www.fiverr.com", "fiverr.com", "blog.fiverr.com",
  "www.peopleperhour.com", "peopleperhour.com",
];
const chromeSays = await worker.evaluate(
  (hosts) =>
    Promise.all(
      hosts.map(async (h) => [h, await chrome.permissions.contains({ origins: [`https://${h}/*`] })])
    ),
  HOSTS
);
// The real platform table, evaluated inside the extension — not a copy of its regexes. A duplicated
// table is what drifted last time: this file would have kept claiming Fiverr after it was parked.
const platformsSrc = readFileSync(new URL("../src/content/platforms.js", import.meta.url), "utf8");
const codeSays = await worker.evaluate(
  ([hosts, code]) => {
    eval(code);
    return hosts.map((h) => [h, Boolean(globalThis.ALPlatforms.platformFor(`https://${h}/x`))]);
  },
  [HOSTS, platformsSrc]
);

console.log("\n      host                      chrome allows   code claims");
let mismatched = 0;
for (const [i, [host, allowed]] of chromeSays.entries()) {
  const claimed = codeSays[i][1];
  const ok = allowed === claimed;
  if (!ok) { mismatched++; problems.push(`${host}: chrome=${allowed} code=${claimed}`); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${host.padEnd(24)} ${String(allowed).padEnd(15)} ${claimed}`);
}
console.log(mismatched === 0 ? "PASS  permission and recognition agree on every host" : `FAIL  ${mismatched} mismatch(es)`);

await context.close();

if (problems.length) {
  console.log("\n" + problems.length + " problem(s):");
  for (const p of problems) console.log("  " + p);
  process.exit(1);
}
console.log("\nextension loads clean");
