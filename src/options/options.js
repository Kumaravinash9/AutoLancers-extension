/** Settings: where the backend is, and the token to reach it with. */

const DEFAULTS = { apiUrl: "http://localhost:8010", token: "" };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(Object.keys(DEFAULTS)).then((stored) => {
  const current = { ...DEFAULTS, ...stored };
  $("apiUrl").value = current.apiUrl;
  $("token").value = current.token;
});

// Collection settings live in local storage, not sync: they are about this machine's browsing,
// and syncing "start exporting when I open Upwork" to another device is a surprise, not a feature.
const COLLECT_KEY = "collect.settings";

// Kept in step with `PUSH_DEFAULTS` in src/background/api.js. Not imported: this page is a classic
// script and making it a module to share two booleans is not a trade worth making.
const PUSH_DEFAULTS = { pushToBackend: true, useLlm: false };

chrome.storage.local.get(COLLECT_KEY).then(({ [COLLECT_KEY]: stored = {} }) => {
  const current = { ...PUSH_DEFAULTS, ...stored };
  $("concurrency").value = stored.concurrency ?? 1;
  $("pushToBackend").checked = Boolean(current.pushToBackend);
  $("useLlm").checked = Boolean(current.useLlm);
});

$("save").addEventListener("click", async () => {
  const apiUrl = $("apiUrl").value.trim().replace(/\/+$/, "");
  await chrome.storage.sync.set({ apiUrl, token: $("token").value.trim() });

  const { [COLLECT_KEY]: stored = {} } = await chrome.storage.local.get(COLLECT_KEY);
  await chrome.storage.local.set({
    [COLLECT_KEY]: {
      ...stored,
      // 0 is meaningful: read every page at once.
      concurrency: Math.min(8, Math.max(0, Number($("concurrency").value) || 0)),
      pushToBackend: $("pushToBackend").checked,
      useLlm: $("useLlm").checked,
    },
  });

  $("saved").textContent = "Saved.";
  $("saved").className = "hint ok";
});

/**
 * Prove the two settings work together before the user is standing on a job page wondering why
 * nothing happens. Checks reachability and the token separately, because "backend is down" and
 * "token is wrong" need different fixes.
 */
$("test").addEventListener("click", async () => {
  const out = $("result");
  const apiUrl = $("apiUrl").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();
  out.className = "hint";
  out.textContent = "Checking…";

  try {
    const health = await fetch(`${apiUrl}/health`);
    if (!health.ok) throw new Error(`backend answered ${health.status}`);
  } catch {
    out.textContent = `Can't reach ${apiUrl}. Is the backend running?`;
    return;
  }

  if (!token) {
    out.textContent = "Backend is reachable, but there's no token yet.";
    return;
  }

  const me = await fetch(`${apiUrl}/accounts/me`, { headers: { authorization: `Bearer ${token}` } });
  if (me.status === 401) {
    out.textContent = "Backend is reachable, but that token was rejected.";
    return;
  }
  if (!me.ok) {
    out.textContent = `Backend answered ${me.status}.`;
    return;
  }

  const user = await me.json();
  out.className = "hint ok";
  out.textContent = `Connected as ${user.email}.`;
});
