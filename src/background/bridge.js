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

/**
 * Every app tab currently listening.
 *
 * A Set of ports rather than one, because the app may be open in several tabs and each gets its own.
 * Service workers are torn down when idle, which takes the ports with them — that is survivable
 * precisely because a reconnecting page asks for the current state as its first act.
 */
const listeners = new Set();

/** What the app is allowed to ask for, and nothing else. */
const QUERIES = new Set(["ping", "state"]);

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
export function openBridge({ state, version }) {
  chrome.runtime.onMessageExternal.addListener((message, _sender, respond) => {
    if (!QUERIES.has(message?.type)) return false;

    if (message.type === "ping") {
      // How the app knows the extension is installed at all. There is no other way to ask: a page
      // cannot enumerate extensions, and a failed sendMessage is indistinguishable from a wrong id.
      respond({ ok: true, version });
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
