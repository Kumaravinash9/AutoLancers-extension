/**
 * Sequential page collector.
 *
 * The popup cannot run this: it is destroyed the moment focus moves, and a collection takes tens of
 * seconds. So the run lives in the service worker, the popup only starts it and reads progress from
 * storage.
 *
 * A run starts exactly one way: you press Collect. There is no timer, no schedule, and no trigger
 * on navigation — an earlier version started when you arrived on Upwork, and that is removed. The
 * only entry point is the `collect:start` message the popup sends on a click.
 *
 * That matters because this is the part of the extension that most resembles the automation
 * Upwork's policy prohibits, and the account at risk is the user's. Running all eight pages in
 * parallel has already tripped their bot detection once.
 *
 * The constraints:
 *
 *   1. Never without a click. No alarms, no navigation listener, nothing on install.
 *   2. Concurrency is a setting, defaulting to all pages at once at the user's direction. At 1 it
 *      reads one page at a time with a varied human-length pause; the comment on
 *      DEFAULT_CONCURRENCY records the trade that was made.
 *   3. A fixed list of your own pages. No links followed, no pagination, nothing discovered.
 *
 * If you are tempted to add a `chrome.alarms` trigger here, that is the line between "a tool I ran"
 * and "a bot that watches the site", and it is the wrong side of it.
 */

const STATE_KEY = "collect.state";
const SETTINGS_KEY = "collect.settings";

/** Pause between pages. Long enough to read like a person clicking, not a script. */
const MIN_GAP_MS = 4000;
const MAX_GAP_MS = 9000;

/** Longest we'll wait for a page to finish loading before giving up on it. */
const LOAD_TIMEOUT_MS = 25_000;

/** Extra settle time after `complete`, because Upwork paints its content client-side. */
const RENDER_WAIT_MS = 2500;

/**
 * How many pages to read at once. 0 means "all of them".
 *
 * One, because running all eight in parallel tripped Upwork's bot detection in practice — the
 * browser was challenged for a period while the same account still logged in fine from a phone,
 * which is the signature of a flagged browser rather than an actioned account.
 *
 * This default is not caution in the abstract; it is the observed result. Set it to 0 in Settings
 * to go back to all-at-once: roughly 4 seconds instead of 76, and the thing that got flagged.
 */
const DEFAULT_CONCURRENCY = 1;

export const DEFAULT_KEYS = ["best_matches", "most_recent", "saved_jobs", "invites"];

// `link` is the fragment to look for when getting there by clicking; `url` is the fallback when
// no such link is on the current page.
export const PAGES = [
  { key: "best_matches", label: "Best matches", link: "/nx/find-work/best-matches", url: "https://www.upwork.com/nx/find-work/best-matches" },
  { key: "most_recent", label: "Most recent", link: "/nx/find-work/most-recent", url: "https://www.upwork.com/nx/find-work/most-recent" },
  { key: "saved_jobs", label: "Saved jobs", link: "/nx/search/jobs/saved", url: "https://www.upwork.com/nx/search/jobs/saved/" },
  { key: "invites", label: "Invites", link: "/nx/find-work/invites", url: "https://www.upwork.com/nx/find-work/invites" },
  { key: "home", label: "Home", link: "/nx/wm/freelancer/home", url: "https://www.upwork.com/nx/wm/freelancer/home" },
  { key: "contracts", label: "Contracts", link: "/nx/wm/freelancer/contracts", url: "https://www.upwork.com/nx/wm/freelancer/contracts" },
  { key: "reports", label: "Reports (in progress)", link: "/nx/reports/overview", url: "https://www.upwork.com/nx/reports/overview/?tab=in-progress" },
  { key: "messages", label: "Message rooms", link: "/ab/messages", url: "https://www.upwork.com/ab/messages/rooms/" },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Varied, not fixed — a metronome is the easiest automation signature there is. */
function humanGap() {
  return MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
}

async function setState(patch) {
  const { [STATE_KEY]: current = {} } = await chrome.storage.local.get(STATE_KEY);
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

/**
 * Wait until a tab has actually loaded, rather than guessing with a fixed sleep.
 *
 * A sleep is wrong in both directions: too short and the reader runs against an empty DOM and
 * reports zero items with no error, too long and every run drags. Polling the tab's own status
 * also catches the tab being closed underneath us, which a sleep turns into a confusing
 * "No tab with id" from the injection instead.
 */
async function waitForTab(tabId) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  for (;;) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error("The tab was closed before it could be read.");
    }
    if (tab.status === "complete") break;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the page to load.");
    await sleep(250);
  }
  // Loaded is not the same as painted; give the client-side render its moment.
  await sleep(RENDER_WAIT_MS);
}

/** Inject the readers and call one, on a tab that is known to be ready. */
async function readInTab(tabId, func, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/extract.js"] });
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

/**
 * Read a page in a tab, reusing one if given.
 *
 * Sequentially there is no reason to open a tab per page: one tab navigated from URL to URL does
 * the same work while only ever putting a single extra tab on screen. Opening and discarding eight
 * is both alarming to watch and a louder pattern than one tab browsing.
 */
async function readOnePage(page, reuseTabId = null) {
  let tabId = reuseTabId;
  try {
    if (tabId === null) {
      // Opened inactive so the collection doesn't yank focus away mid-run.
      const tab = await chrome.tabs.create({ url: page.url, active: false });
      tabId = tab.id;
    } else {
      await chrome.tabs.update(tabId, { url: page.url });
      // `update` resolves before navigation starts; without this the wait can pass against the
      // page we were already on and read the wrong one.
      await sleep(300);
    }
    await waitForTab(tabId);
    return await readInTab(tabId, (key) => readList(key), [page.key]);
  } finally {
    // Only close what we own. A reused tab is closed once, by the caller, at the end of the run.
    if (reuseTabId === null && tabId !== null) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

/**
 * Walk the pages by clicking links in a tab the user already has open.
 *
 * Upwork routes client-side, so following its own nav re-renders without a document request. That
 * is both quieter than navigating by URL and closer to what it is meant to look like: someone
 * clicking around their own account. It also creates no tabs at all.
 *
 * Falls back to a real navigation, in the same tab, whenever the link is not on the current page —
 * there is no path from "Contracts" to "Saved jobs" if the nav does not offer one.
 */
async function readByClicking(pages, tabId, results, errors, onDone) {
  for (const [index, page] of pages.entries()) {
    const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
    if (state.cancelled) return;

    await setState({ current: page.label });
    try {
      const attempt = await readInTab(tabId, (fragment) => clickTo(fragment), [page.link]);

      if (attempt?.already) {
        // Nothing to navigate to; read where we stand.
      } else if (attempt?.clicked) {
        const settled = await readInTab(
          tabId,
          (previous) => afterRouteChange(previous),
          [attempt.before]
        );
        if (!settled?.ok) throw new Error("The page did not finish rendering after the click.");
      } else {
        // No link here — navigate this one directly, still in the same tab.
        await chrome.tabs.update(tabId, { url: page.url });
        await sleep(300);
        await waitForTab(tabId);
      }

      results[page.key] = await readInTab(tabId, (key) => readList(key), [page.key]);
    } catch (err) {
      errors[page.key] = String(err?.message || err);
    }

    await onDone(index + 1);
    if (index < pages.length - 1) await sleep(humanGap());
  }
}

async function run(selectedKeys) {
  const pages = PAGES.filter((p) => selectedKeys.includes(p.key));
  await setState({
    running: true,
    cancelled: false,
    done: 0,
    total: pages.length,
    results: {},
    errors: {},
    startedAt: Date.now(),
  });
  await badge("0/" + pages.length);

  const results = {};
  const errors = {};
  let finished = 0;

  const { concurrency = DEFAULT_CONCURRENCY, navigateByClicking = true } = await autoSettings();

  // Clicking needs a tab already on Upwork to start from, and only makes sense one page at a time.
  if (navigateByClicking && (Number(concurrency) || 1) === 1) {
    const [openTab] = await chrome.tabs.query({ url: "https://www.upwork.com/*" });
    if (openTab) {
      await readByClicking(pages, openTab.id, results, errors, async (done) => {
        await setState({ done, results, errors });
        await badge(`${done}/${pages.length}`);
      });
      await finish(results, errors);
      return;
    }
    await setState({ note: "No Upwork tab open — opened one instead of clicking through." });
  }

  // 0 (or anything past the page count) means one lane per page — the whole run in parallel.
  const requested = Number(concurrency) || 0;
  const lanes = requested > 0 ? Math.min(requested, pages.length) : pages.length;

  // Work queue rather than fixed batches: a slow page holds up only its own lane, not a whole
  // group, so raising the dial actually buys the speed it promises.
  const queue = [...pages];

  // One lane means one tab for the whole run, reused. Several lanes each own their own.
  let sharedTabId = null;
  if (lanes === 1) {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    sharedTabId = tab.id;
  }

  async function lane() {
    for (;;) {
      const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
      if (state.cancelled) return;

      const page = queue.shift();
      if (!page) return;

      await setState({ current: page.label });
      try {
        results[page.key] = await readOnePage(page, sharedTabId);
      } catch (err) {
        // One unreachable page must not end the run — the rest are still worth having.
        errors[page.key] = String(err?.message || err);
      }

      finished += 1;
      await setState({ done: finished, results, errors });
      await badge(`${finished}/${pages.length}`);

      // Only meaningful when a lane has more work waiting. Running fully in parallel each lane
      // takes one page and the queue is empty, so no pause happens at all.
      if (queue.length) await sleep(humanGap());
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => lane()));
  if (sharedTabId !== null) await chrome.tabs.remove(sharedTabId).catch(() => {});

  await finish(results, errors);
}

/** Optional per-job description pass, then mark the run complete. */
async function finish(results, errors) {
  const { fullDescriptions = false, concurrency = DEFAULT_CONCURRENCY } = await autoSettings();
  const lanes = Number(concurrency) || 1;
  if (fullDescriptions) {
    const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
    if (!state.cancelled) {
      await setState({ current: "Full descriptions", phase: "descriptions" });
      const summary = await deepenDescriptions(results, lanes, async (done, total, live) => {
        await setState({ descDone: done, descTotal: total, results: live });
        await badge(`${done}/${total}`);
      });
      await setState({ descSummary: summary });
    }
  }

  await setState({
    running: false,
    current: null,
    phase: null,
    finishedAt: Date.now(),
    results,
    errors,
  });
  const failed = Object.keys(errors).length;
  await badge(failed ? String(failed) : "", failed ? "#a3372c" : "#14563f");
  // Clear a success badge after a moment; a permanent tick becomes furniture.
  if (!failed) setTimeout(() => void badge(""), 8000);
}

/**
 * Open each discovered job and take its full description.
 *
 * Listing pages truncate — Upwork shows a preview with a "more" link, so what the cards give us is
 * genuinely partial no matter how well it is parsed. This is the only way to the whole text, and it
 * costs one page load per job, which is why it is off unless asked for.
 */
async function deepenDescriptions(results, lanes, onProgress) {
  const jobs = Object.values(results)
    .flatMap((page) => page?.jobs || [])
    .filter((job) => job?.url && !job.description_complete);

  // One entry per id: the same job appears on best-matches and most-recent alike.
  const unique = [...new Map(jobs.map((job) => [job.external_id, job])).values()];
  if (!unique.length) return { deepened: 0, failed: 0 };

  const queue = [...unique];
  const problems = {};
  let deepened = 0;
  let failed = 0;

  async function lane() {
    // One tab per lane, navigated job to job, closed when the lane runs dry.
    let tabId = null;
    try {
    for (;;) {
      const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
      if (state.cancelled) return;

      const job = queue.shift();
      if (!job) return;

      if (tabId === null) {
        const tab = await chrome.tabs.create({ url: job.url, active: false });
        tabId = tab.id;
      } else {
        await chrome.tabs.update(tabId, { url: job.url });
        await sleep(300);
      }
      try {
        await waitForTab(tabId);
        const result = await readInTab(tabId, () => readJob());
        if (result?.error) problems[job.external_id] = result.error;
        if (result && !result.error) {
          // Write through to every copy of this job across the pages that listed it.
          for (const page of Object.values(results)) {
            for (const entry of page?.jobs || []) {
              if (entry.external_id !== job.external_id) continue;
              entry.description = result.description || entry.description;
              entry.description_complete = Boolean(result.description);
              entry.client = result.client;
              entry.experience_level = result.experience_level;
              entry.project_length = result.project_length;
            }
          }
          deepened += 1;
        } else {
          failed += 1;
          problems[job.external_id] ||= "no result returned";
        }
      } catch (err) {
        // Counting failures without saying why makes a broken selector look like a quiet no-op.
        failed += 1;
        problems[job.external_id] = String(err?.message || err);
      }

      await onProgress(deepened + failed, unique.length, results);
      if (queue.length && lanes === 1) await sleep(humanGap());
    }
    } finally {
      if (tabId !== null) await chrome.tabs.remove(tabId).catch(() => {});
    }
  }

  await Promise.all(Array.from({ length: Math.min(lanes, unique.length) }, () => lane()));
  return { deepened, failed, problems };
}

/**
 * One-time cleanup of settings saved before the bot-detection incident.
 *
 * Stored values win over defaults, so lowering DEFAULT_CONCURRENCY did nothing for anyone who had
 * already saved "all at once" — they kept running the configuration that got their browser flagged
 * while the code claimed a safe default. Dropping the stored value once lets the default apply;
 * setting it again in Settings sticks, because the marker records that this ran.
 */
async function migrateSettings() {
  const { [SETTINGS_KEY]: stored } = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored || stored.migratedParallel) return;

  const cleaned = { ...stored, migratedParallel: true };
  if (Number(cleaned.concurrency) === 0) delete cleaned.concurrency;
  // These controlled the navigation trigger, which no longer exists.
  delete cleaned.auto;
  delete cleaned.cooldownMin;
  await chrome.storage.local.set({ [SETTINGS_KEY]: cleaned });
}

async function autoSettings() {
  await migrateSettings();
  const { [SETTINGS_KEY]: stored = {} } = await chrome.storage.local.get(SETTINGS_KEY);
  return {
    concurrency: DEFAULT_CONCURRENCY,
    fullDescriptions: false,
    keys: DEFAULT_KEYS,
    ...stored,
  };
}

/** Progress on the toolbar icon, so a run is visible without opening the popup. */
async function badge(text, colour = "#14563f") {
  await chrome.action.setBadgeBackgroundColor({ color: colour }).catch(() => {});
  await chrome.action.setBadgeText({ text }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "collect:start") {
    // Not awaited: the sender should not block for the length of a run.
    void run(message.keys || PAGES.map((p) => p.key));
    respond({ started: true });
    return true;
  }
  if (message?.type === "collect:cancel") {
    void setState({ cancelled: true, running: false });
    respond({ cancelled: true });
    return true;
  }
  if (message?.type === "collect:pages") {
    respond({ pages: PAGES });
    return true;
  }
  return false;
});
