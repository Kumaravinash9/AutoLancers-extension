/**
 * The live link to the AutoLancers app, which is open in the same browser.
 *
 * The backend already records whether a marketplace can be read, and the app can ask it. But that is
 * a round trip and a refresh away, and the interesting moment is *now*: you press Collect while
 * looking at Upwork, and the dashboard is a tab away with a board of scores on it. Telling that tab
 * directly is both instant and free.
 *
 * `externally_connectable` rather than a content script, on purpose. The app's page opens the port and
 * the extension answers — so nothing of ours is injected into your own site, and the manifest's
 * `matches` list is the whole of the trust boundary. It also means the app works with the extension
 * absent: `chrome.runtime` simply is not there, and it carries on with what the backend told it.
 *
 * This does **not** replace the recorded status. A port only reaches a tab that is open at that
 * moment, and during a collection you are looking at the marketplace, not at the dashboard — so the
 * common case is that nobody is listening. The persisted row is what covers opening the app an hour
 * later, which is exactly the case the whole session-status idea exists for.
 */

import { connection } from "./api.js";

/**
 * Every app tab currently listening.
 *
 * A Set of ports rather than one, because the app may be open in several tabs and each gets its own.
 * Service workers are torn down when idle, which takes the ports with them — that is survivable
 * precisely because a reconnecting page asks for the current state as its first act.
 */
const listeners = new Set();

/** Which user the stored credential belongs to. Local, not synced: it describes this browser. */
const OWNER_KEY = "connection.owner";

/** Where the app that connected us lives, so our own pages can offer a way back. */
const APP_KEY = "connection.app";

/**
 * The `sub` inside a JWT, without verifying it.
 *
 * Verification is the backend's job and needs the signing key, which the extension does not have and
 * should not. This only answers "whose token am I holding", and for that an unverified read is
 * enough: a forged `sub` would fail at the backend on the very next request, so lying here buys
 * nothing. Returns null for an opaque API token, which carries no claims at all.
 */
function subjectOf(token) {
  try {
    const [, payload] = String(token).split(".");
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json).sub || null;
  } catch {
    return null;
  }
}

/** What the app is allowed to ask for, and nothing else. */
const QUERIES = new Set(["ping", "state", "connect", "sync"]);

/**
 * Take the backend address and a token from the app.
 *
 * This is how the extension gets configured without anyone opening Settings. The app is already
 * signed in — it holds a session cookie the extension cannot — so it can mint a token through
 * `POST /accounts/tokens` and hand it over. Both run in the same browser, and the manifest's
 * `externally_connectable` list decides who is allowed to speak here, so no other page can.
 *
 * That matters because it removes the only reason a non-admin needed the options page at all. Pasting
 * a token by hand was the whole of it.
 *
 * Refused unless the token looks like one and the address is a real URL: a bad value stored here
 * fails later, at collection time, as an authentication error that looks like the backend's fault.
 */
async function connect({ apiUrl, token, settings, userId, appUrl }) {
  const url = String(apiUrl || "").trim().replace(/\/+$/, "");
  const secret = String(token || "").trim();
  if (!secret) return { ok: false, error: "No token in the handover." };
  try {
    new URL(url);
  } catch {
    return { ok: false, error: `Not a usable backend address: ${apiUrl}` };
  }
  await chrome.storage.sync.set({ apiUrl: url, token: secret });

  /**
   * Whose token this is.
   *
   * Stored because the extension holds exactly one credential and a browser can be used by more than
   * one person. Without it, signing into the app as someone else left the extension holding the
   * first user's token — and a sync would then file the second person's marketplace data into the
   * first person's account, silently, behind a progress bar that said it was working.
   *
   * Taken from the token itself when the app does not say: an extension JWT carries `sub`, so the
   * question "whose is this?" needs no network call and cannot disagree with the credential it
   * describes.
   */
  await chrome.storage.local.set({
    [OWNER_KEY]: userId || subjectOf(secret) || null,
    // Where the app lives, so the extension's own pages can offer a way back to it. The extension
    // knows the *backend* address from the handover but has no other way to learn the front end's —
    // they are different origins and only the app knows its own.
    ...(appUrl ? { [APP_KEY]: String(appUrl).replace(/\/+$/, "") } : {}),
  });

  /**
   * The collection settings, when the app sends them.
   *
   * This is what keeps hiding the options page from switching a feature off. `useLlm` decides whether
   * the backend shapes a capture into the schema it wants to store — so with the page hidden and the
   * flag defaulting to false, nobody who is not an admin would ever get that, and the absence would
   * look like the model simply not helping rather than a setting nobody could reach.
   *
   * Sent from the app, it is set once by whoever administers the deployment and inherited by every
   * browser that connects. Only known keys are taken, so a future field in the app cannot quietly
   * write something here that nothing reads.
   */
  const allowed = ["pushToBackend", "useLlm", "concurrency", "showTab"];
  const incoming = Object.fromEntries(
    Object.entries(settings || {}).filter(([key]) => allowed.includes(key))
  );
  if (Object.keys(incoming).length) {
    const { "collect.settings": stored = {} } = await chrome.storage.local.get("collect.settings");
    await chrome.storage.local.set({ "collect.settings": { ...stored, ...incoming } });
  }

  // Deliberately opens nothing. An earlier version popped the options page here as proof the
  // handover had worked, and it was the wrong instinct: it took focus off the app at the exact
  // moment the next thing to press was on it. The real evidence is the run itself — the app watches
  // progress over the port, and a tab full of marketplace pages is harder to miss than a settings
  // screen saying there is nothing to settle.

  return { ok: true, apiUrl: url, applied: Object.keys(incoming) };
}

/**
 * Start a run on the app's behalf, once the credential is known to work.
 *
 * There is nothing to *refresh* here, which is worth stating because the word invites a mechanism
 * that does not exist: an API token has no expiry, only a `revoked_at`. It is live until someone
 * revokes it. So the check is whether it still works — `/accounts/me` — and the three ways it can
 * fail need three different sentences from the app, not one "sync failed".
 *
 * The extension deliberately has no login of its own. A page asking for your password is a different
 * trust posture from one holding a revocable token, and the app can already mint one: when the token
 * is missing or dead, the honest move is to say so and let the app re-mint, not to collect
 * credentials here.
 */
async function sync({ platform = "upwork", userId } = {}, start) {
  const { apiUrl, token } = await connection();
  if (!token) return { ok: false, reason: "needs_token" };

  // Whose token this is, against who is asking. The app knows who it is signed in as; the extension
  // only knows who it was handed a credential for. Comparing the two is what stops a browser where a
  // second person signed in from filing their jobs into the first person's account — a failure that
  // produced no error at all, because from the backend's side the token was perfectly valid.
  const { [OWNER_KEY]: owner } = await chrome.storage.local.get(OWNER_KEY);
  const holder = owner || subjectOf(token);
  if (userId && holder && userId !== holder) {
    return { ok: false, reason: "different_user", holder };
  }

  try {
    const response = await fetch(`${apiUrl}/accounts/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    // Revoked, or issued against a database that has since been reset. Either way the app has to
    // mint another; the extension cannot.
    if (response.status === 401) return { ok: false, reason: "revoked" };
    if (!response.ok) return { ok: false, reason: "unreachable", status: response.status };
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  return start(platform);
}

/**
 * Announce something to every listening app tab.
 *
 * Never throws. A tab that navigated away mid-post leaves a dead port whose `postMessage` raises, and
 * a collection must not fail because a dashboard was closed at the wrong moment.
 */
export function announce(event) {
  for (const port of [...listeners]) {
    try {
      port.postMessage(event);
    } catch {
      listeners.delete(port);
    }
  }
}

/**
 * Start listening for the app.
 *
 * Two channels, because they answer different questions. A one-shot message answers "are you there,
 * and what do you know?" — which is what a freshly loaded page needs, since it has missed every event
 * that happened before it existed. A long-lived port carries what happens next.
 */
export function openBridge({ state, version, start }) {
  chrome.runtime.onMessageExternal.addListener((message, _sender, respond) => {
    if (!QUERIES.has(message?.type)) return false;

    if (message.type === "ping") {
      // How the app knows the extension is installed at all. There is no other way to ask: a page
      // cannot enumerate extensions, and a failed sendMessage is indistinguishable from a wrong id.
      respond({ ok: true, version });
      return true;
    }

    if (message.type === "connect") {
      void connect(message).then(respond);
      return true;
    }

    if (message.type === "sync") {
      void sync(message, start).then(respond);
      return true;
    }

    // `state` is async, so the listener must return true to keep the channel open for the reply.
    void state().then((current) => respond({ ok: true, ...current }));
    return true;
  });

  chrome.runtime.onConnectExternal.addListener((port) => {
    if (port.name !== "autolancers") return;
    listeners.add(port);
    port.onDisconnect.addListener(() => listeners.delete(port));

    // Send the current state immediately rather than waiting for the next event. A page that connects
    // between collections would otherwise sit blank until something happened, which reads as "the
    // extension isn't connected" — the one thing it has just proved wrong.
    void state().then((current) => {
      try {
        port.postMessage({ type: "state", ...current });
      } catch {
        listeners.delete(port);
      }
    });
  });
}
