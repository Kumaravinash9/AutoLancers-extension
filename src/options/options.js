/** Settings: where the backend is, and the token to reach it with. */

const DEFAULTS = { apiUrl: "http://localhost:8010", token: "" };
const $ = (id) => document.getElementById(id);

/**
 * Settings are for whoever administers the deployment, not for whoever uses it.
 *
 * Nothing here is part of the product. The extension configures itself: the AutoLancers app hands it
 * the backend address and a token over the bridge when you sign in, so there has never been a reason
 * for an ordinary user to open this page — and every knob on it is one they could get wrong. Hiding
 * `concurrency` in particular means nobody can raise it to 0, which is the value that got a browser
 * flagged by Upwork's bot detection.
 *
 * **This is tidiness, not access control, and it must not be mistaken for it.** The page is reachable
 * by URL, `chrome.storage` is editable from this extension's own devtools, and the source is on disk.
 * Anyone determined can change any of these. If a setting ever needs to be genuinely restricted, the
 * enforcement belongs on the backend — `require_admin` is already there for it — because that is the
 * only side a client cannot talk its way around.
 */
async function isAdmin() {
  const { apiUrl, token } = { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
  // No token means nobody has connected this browser yet, and the page is the only way to do it by
  // hand — so it stays open. Locking the door before anyone has a key locks everyone out.
  if (!token) return true;
  try {
    const response = await fetch(`${String(apiUrl).replace(/\/+$/, "")}/accounts/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return false;
    const me = await response.json();
    return me?.role === "admin";
  } catch {
    // The backend is unreachable. Showing the settings is the useful failure: this page is where you
    // fix a wrong address, and hiding it would make an unreachable backend unfixable.
    return true;
  }
}

// Both views start hidden, so neither flashes before the answer arrives. A settings page that
// appears and then vanishes is worse than one that takes a moment.
void isAdmin().then((admin) => {
  $(admin ? "settings" : "locked").hidden = false;
});

/**
 * A way back to the app, when we know where it is.
 *
 * The extension learns the *backend* address at handover but never the front end's — they are
 * different origins and only the app knows its own, so it sends it. Absent that, the link stays
 * hidden rather than guessing at a URL that would 404.
 */
void chrome.storage.local.get("connection.app").then(({ "connection.app": appUrl }) => {
  if (!appUrl) return;
  const back = $("back");
  back.href = `${appUrl}/profile`;
  back.hidden = false;
});

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
