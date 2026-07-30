/**
 * The popup is the only thing that runs. Opening it does not read the page; clicking does.
 *
 * Reading is the whole product for now: click, see exactly what came off the page, copy it. Sending
 * to AutoLancers is opt-in and only appears once a token is configured, so the extension is useful
 * with zero setup and you can judge the scraper before wiring anything to it.
 *
 * Nothing is declared as a content script, so nothing runs in the background and nothing paginates.
 * That is deliberate: a tool you point at one open page is a different thing from one that watches
 * the site for you.
 */

import { PUSH_DEFAULTS, describePush, pushPosting, pushProfile } from "../background/api.js";

const $ = (id) => document.getElementById(id);
const main = $("main");

const DEFAULTS = { apiUrl: "http://localhost:8010", token: "" };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Inject the readers into the open tab, then call one by name. */
async function readPage(fn) {
  const tab = await activeTab();
  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content/platforms.js", "src/content/extract.js"],
  });
  const injectError = injected.find((frame) => frame.error)?.error;
  if (injectError) throw new Error(`Couldn't load the readers: ${injectError}`);

  const frames = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (name) => {
      // A tab that was open before the extension was updated still holds the previous script's
      // globals, and this one will be missing. Saying so beats a silent undefined that reads as
      // "the page had nothing on it".
      if (!globalThis.ALExtract) throw new Error("Reload this page — the extension was updated.");
      return globalThis.ALExtract[name]();
    },
    args: [fn],
  });

  // executeScript resolves with `error` set rather than rejecting when the injected code throws.
  const frame = frames[0] || {};
  if (frame.error) throw new Error(String(frame.error.message || frame.error));
  return frame.result;
}

function escape(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Sections, so a long profile stays readable instead of becoming one 40-row table. */
const VIEWS = {
  job: [
    ["Posting", ["title", "external_id", "category", "posted_text", "posted_at"]],
    ["Terms", ["work_type", "budget", "experience_level", "project_length", "hours_per_week", "connects_required"]],
    ["Competition", ["proposal_count", "interviewing", "invites_sent", "unanswered_invites", "last_viewed_by_client"]],
    ["Skills", ["skills"]],
    ["Client", ["client"]],
    ["Description", ["description"]],
  ],
  profile: [
    ["Identity", ["display_name", "username", "tagline", "country", "city", "timezone", "availability", "languages"]],
    ["Money", ["hourly_rate_display", "total_earnings"]],
    ["Track record", ["rating", "total_reviews", "job_success", "total_jobs", "total_hours"]],
    ["Skills", ["skills"]],
    ["Portfolio", ["portfolio"]],
    ["Work history", ["work_history"]],
    ["Employment", ["employment"]],
    ["Education", ["education"]],
    ["Certifications", ["certifications"]],
    ["Summary", ["summary"]],
  ],
};

const LABELS = {
  external_id: "Job id",
  posted_text: "Posted",
  posted_at: "Posted (exact)",
  work_type: "Type",
  hours_per_week: "Hours/week",
  connects_required: "Connects",
  proposal_count: "Proposals",
  last_viewed_by_client: "Client last viewed",
  hourly_rate_display: "Rate",
  job_success: "Job success",
  total_reviews: "Reviews",
};

function labelFor(key) {
  return LABELS[key] || key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function isEmpty(value) {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.values(value).every(isEmpty))
  );
}

/** Renders one value, whatever shape it is — scalar, list of strings, list of objects, or object. */
function valueHtml(value) {
  if (isEmpty(value)) return '<span class="missing">not found</span>';

  if (Array.isArray(value)) {
    if (typeof value[0] === "object") {
      return `<ul class="entries">${value
        .map(
          (entry) =>
            `<li>${Object.entries(entry)
              .filter(([, v]) => !isEmpty(v))
              .map(([k, v]) =>
                k === "url" || k === "image"
                  ? `<a href="${escape(v)}" target="_blank">${k}</a>`
                  : `<span><b>${escape(labelFor(k))}:</b> ${escape(v)}</span>`
              )
              .join(" ")}</li>`
        )
        .join("")}</ul>`;
    }
    return escape(value.join(", "));
  }

  if (typeof value === "object") {
    return `<table class="nested">${Object.entries(value)
      .map(
        ([k, v]) =>
          `<tr><th>${escape(labelFor(k))}</th><td class="${isEmpty(v) ? "missing" : ""}">${
            isEmpty(v) ? "not found" : escape(v)
          }</td></tr>`
      )
      .join("")}</table>`;
  }

  return escape(value);
}

/** Drop nulls and empty lists so an AI blank never overwrites a value the selectors found. */
function prune(fields) {
  return Object.fromEntries(
    Object.entries(fields || {}).filter(([, value]) => !isEmpty(value))
  );
}

function renderScraped(data, kind) {
  // A couple of fields read better combined than as raw columns.
  const view = {
    ...data,
    budget:
      data.budget_min === null || data.budget_min === undefined
        ? null
        : `${data.budget_min}–${data.budget_max} ${data.currency}`,
    hourly_rate_display:
      data.hourly_rate === null || data.hourly_rate === undefined
        ? null
        : `${data.hourly_rate} ${data.currency}/hr`,
  };

  let found = 0;
  let total = 0;
  const sections = VIEWS[kind]
    .map(([heading, keys]) => {
      const rows = keys
        .map((key) => {
          const value = view[key];
          total += 1;
          if (!isEmpty(value)) found += 1;
          return `<tr><th>${escape(labelFor(key))}</th><td>${valueHtml(value)}</td></tr>`;
        })
        .join("");
      return `<h3>${escape(heading)}</h3><table class="scraped">${rows}</table>`;
    })
    .join("");

  main.innerHTML = `
    <p class="muted small tally">${found} of ${total} fields found${
      found < total ? " — red rows mean Upwork's markup moved" : ""
    }</p>
    ${sections}
    <div class="buttons">
      <button id="copy">Copy JSON</button>
      <button id="again" class="ghost">Read again</button>
    </div>
    <div class="buttons">
      <button id="ai" class="ghost">Read with AI</button>
      <button id="diag" class="ghost">Copy diagnostics</button>
    </div>
    <div class="buttons"><button id="collect" class="ghost">Collect my pages…</button></div>
    <div id="send"></div>
  `;

  // The LLM reader is opt-in, never automatic. It costs money and seconds per page, so it happens
  // because you chose it — not because a selector quietly broke.
  $("ai").addEventListener("click", async () => {
    const { apiUrl, token } = await settings();
    if (!token) {
      $("ai").textContent = "Needs a token — see Settings";
      return;
    }
    $("ai").textContent = "Reading…";
    try {
      const page = await readPage("readText");
      const response = await fetch(`${apiUrl}/ingest/parse`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind, url: page.url, text: page.text }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || `Backend answered ${response.status}`);
      // Merge, not replace: the selectors already got the id and URL right, and the model is
      // never asked for those — it can't see the address bar.
      renderScraped({ ...data, ...prune(body.fields), _read_by: body.model }, kind);
    } catch (err) {
      $("ai").textContent = escape(err.message).slice(0, 60);
    }
  });

  $("diag").addEventListener("click", async () => {
    $("diag").textContent = "Reading page structure…";
    const report = await readPage("diagnose");
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    $("diag").textContent = `Copied — ${report.attribute_counts?.["data-test"] ?? 0} data-test attrs`;
  });

  $("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy JSON"), 1200);
  });
  $("again").addEventListener("click", () => start());
  $("collect")?.addEventListener("click", () => renderCollect());

  void offerSend(data, kind);
}

/** Only offered when a token exists. Without one there is nothing useful to show here. */
async function offerSend(data, kind) {
  const { token } = await settings();
  if (!token) return;

  $("send").innerHTML = '<button id="push" class="ghost">Send to AutoLancers</button>';
  $("push").addEventListener("click", async () => {
    $("push").disabled = true;
    $("push").textContent = "Sending…";
    try {
      // The same client as the collector uses, so a job stored from its own page and one stored from
      // a listing agree on the shape they arrive in — and on how a 401 is worded.
      const saved = kind === "job" ? await pushPosting(data) : await pushProfile(data);
      $("send").innerHTML =
        kind === "job"
          ? `<p class="scored">Scored <b>${Math.round(saved.score)}</b>${
              saved.rejected ? ` — ${escape(saved.rejection_reason)}` : ""
            }</p>`
          : `<p class="scored">Saved ${saved.skills} skills.</p>`;
    } catch (err) {
      $("send").innerHTML = `<p class="error small">${escape(err.message)}</p>`;
    }
  });
}

/**
 * Which page we are looking at, according to the platform registry.
 *
 * The allowlist lives in `src/content/platforms.js` now, so supporting another marketplace is an
 * entry there rather than another branch here.
 */
const STATE_KEY = "collect.state";

/**
 * Which pages start ticked.
 *
 * Job listings, plus your own profile — which is your data, and is what every score is computed
 * against, so a board built without it is scored against nothing.
 *
 * Messages stays off because that list is two-party data — the other half belongs to someone who
 * never agreed to any of this — and orders and contracts are rarely what someone is after on a
 * first run.
 */
const DEFAULT_ON = /(own_profile|pph_profile|best_matches|most_recent|saved_jobs|invites|pph_feed|fvr_briefs)/;

let REGISTRY = null;

async function registry(url) {
  if (!REGISTRY) REGISTRY = await chrome.runtime.sendMessage({ type: "collect:pages", url });
  return REGISTRY;
}

const PAGE_KINDS = [
  { kind: "profile", label: "Freelancer profile", match: "isProfilePage", example: "profileExample" },
  { kind: "job", label: "Job posting", match: "isJobPage", example: "jobExample" },
];

/**
 * The page picker for a collection.
 *
 * `forPlatform` is passed when you chose a marketplace from the list instead of being on one — the
 * collector can still run, it just opens its own tab rather than walking yours.
 */
async function renderCollect(forPlatform = null) {
  const tab = await activeTab();
  const reg = forPlatform
    ? await chrome.runtime.sendMessage({ type: "collect:pages", platformId: forPlatform })
    : await registry(tab?.url);
  const { pages, platform, label } = reg;
  const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
  const { "collect.settings": collectSettings = {} } =
    await chrome.storage.local.get("collect.settings");
  const push = { ...PUSH_DEFAULTS, ...collectSettings };
  // Filing needs somewhere to file to. Without a token the two controls below would promise
  // something that cannot happen, so they are simply not offered.
  const { token } = await settings();

  main.innerHTML = `
    <p class="muted small">${escape(label || "This site")} — walks these pages one at a time, in a
    tab you have open where it can.</p>
    <div class="checks">${pages
      .map(
        (p) => `<label class="check">
          <input type="checkbox" value="${escape(p.key)}" ${DEFAULT_ON.test(p.key) ? "checked" : ""} />
          <span>${escape(p.label)}${p.reads === "rooms" ? " <em>previews only</em>" : ""}</span>
        </label>`
      )
      .join("")}</div>
    <label class="check deep">
      <input id="deep" type="checkbox" ${collectSettings.fullDescriptions ? "checked" : ""} />
      <span>Also open each job for its full description
        <em>listings only show a preview — one page load per job</em></span>
    </label>
    ${
      token
        ? `<label class="check deep">
             <input id="push-on" type="checkbox" ${push.pushToBackend ? "checked" : ""} />
             <span>Send each page to AutoLancers as it finishes
               <em>every job listing becomes a project, deduped by its marketplace id</em></span>
           </label>
           <label class="check deep">
             <input id="push-llm" type="checkbox" ${push.useLlm ? "checked" : ""} />
             <span>Let the AI fill fields the selectors missed
               <em>costs tokens per page — only runs when something is actually missing</em></span>
           </label>`
        : `<p class="muted small">Add a token in Settings to file what this collects.</p>`
    }
    <div class="buttons">
      <button id="go">Collect</button>
      <button id="back" class="ghost">Back</button>
    </div>
    <div id="progress"></div>
  `;

  $("back").addEventListener("click", () => start());
  $("go").addEventListener("click", async () => {
    const keys = [...document.querySelectorAll(".checks input:checked")].map((i) => i.value);
    if (!keys.length) return;
    const { "collect.settings": stored = {} } = await chrome.storage.local.get("collect.settings");
    await chrome.storage.local.set({
      "collect.settings": {
        ...stored,
        fullDescriptions: $("deep").checked,
        // Left alone when there is no token, so a run without one cannot silently clear a choice
        // made while one was configured.
        ...(token
          ? { pushToBackend: $("push-on").checked, useLlm: $("push-llm").checked }
          : {}),
      },
    });
    await chrome.runtime.sendMessage({ type: "collect:start", keys, platform });
    main.innerHTML = '<div id="progress"></div>';
    void watch(pages.filter((p) => keys.includes(p.key)));
  });

  if (state.running) {
    main.innerHTML = '<div id="progress"></div>';
    void watch(pages);
  }
}

/**
 * One line of the live checklist.
 *
 * Each page moves pending → reading → a count, so the animation carries information rather than
 * decorating a wait. A bare spinner would say something is happening; this says what, and what it
 * found.
 */
function exportRow(page, state) {
  const result = (state.results || {})[page.key];
  const failure = (state.errors || {})[page.key];
  const push = (state.pushes || {})[page.key];
  const active = state.running && state.current === page.label;

  let status = "pending";
  let value = "";
  if (failure) {
    status = "failed";
    value = escape(failure).slice(0, 40);
  } else if (result) {
    status = "done";
    value = `${result.count ?? (result.jobs || []).length} found`;
  } else if (active) {
    status = "active";
    value = "reading…";
  }

  // What the backend made of it, on its own line. A page can be read perfectly and still fail to
  // file — a token that expired, a backend that isn't running — and one shared status would report
  // that as a scrape failure, sending someone to debug the wrong half.
  const filed = push
    ? `<span class="step-filed ${push.error ? "failed" : ""}">${escape(describePush(push))}</span>`
    : "";

  return `<li class="step ${status}">
    <span class="dot" aria-hidden="true"></span>
    <span class="step-label">${escape(page.label)}</span>
    <span class="step-value">${value}${filed}</span>
  </li>`;
}

async function watch(pages) {
  const progress = $("progress");
  if (!progress) return;

  for (;;) {
    const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
    const total = state.total ?? pages.length;
    const done = state.done ?? 0;
    const found = Object.values(state.results || {}).reduce(
      (sum, value) => sum + (value?.count ?? (value?.jobs || []).length ?? 0),
      0
    );
    const failed = Object.keys(state.errors || {}).length;
    const pct = total ? Math.round((done / total) * 100) : 0;

    // Filing is reported separately from reading throughout: they fail for unrelated reasons.
    const pushes = Object.values(state.pushes || {});
    const stored = pushes.reduce((sum, p) => sum + (p?.stored || 0), 0);
    const unfiled = pushes.filter((p) => p?.error).length;

    progress.innerHTML = `
      ${
        // A stopped run needs its reason at the top, not buried in a red row halfway down a list.
        // "You are signed out" is the whole story, and it names its own fix.
        state.session
          ? `<p class="error">${escape(state.note || state.session.detail)}</p>`
          : ""
      }
      ${
        state.running
          ? `<p class="exporting"><span class="spin" aria-hidden="true"></span>
               ${
                 state.phase === "descriptions"
                   ? `Reading full descriptions… ${state.descDone ?? 0} of ${state.descTotal ?? 0}`
                   : state.phase === "refiling"
                     ? "Filing the full descriptions…"
                     : "Exporting data from your profile…"
               }</p>`
          : `<p class="exporting done-head"><span class="tick" aria-hidden="true">✓</span>
               Export complete</p>`
      }
      <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <span style="width:${pct}%"></span>
      </div>
      <p class="muted small bar-note">${done} of ${total} pages${found ? ` · ${found} items` : ""}${
        failed ? ` · ${failed} failed` : ""
      }${stored ? ` · ${stored} filed` : ""}${unfiled ? ` · ${unfiled} not filed` : ""}</p>
      <ul class="steps">${pages.map((p) => exportRow(p, state)).join("")}</ul>
      ${
        state.running
          ? '<div class="buttons"><button id="stop" class="ghost">Stop</button></div>'
          : `<div class="buttons">
               <button id="copyall">Copy everything</button>
               <button id="rerun" class="ghost">Back</button>
             </div>`
      }
    `;

    $("stop")?.addEventListener("click", async () => {
      $("stop").textContent = "Stopping…";
      await chrome.runtime.sendMessage({ type: "collect:cancel" });
    });
    $("copyall")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(JSON.stringify(state.results, null, 2));
      $("copyall").textContent = "Copied";
      setTimeout(() => ($("copyall").textContent = "Copy everything"), 1400);
    });
    $("rerun")?.addEventListener("click", () => start());

    if (!state.running) return;
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function start() {
  const { [STATE_KEY]: running = {} } = await chrome.storage.local.get(STATE_KEY);
  const tab = await activeTab();

  if (running.running) {
    // A collection in flight is the most important thing on screen; the page reader can wait.
    const { pages } = await registry(tab?.url);
    main.innerHTML = '<div id="progress"></div>';
    void watch(pages);
    return;
  }

  const reg = await registry(tab?.url);

  if (!reg.platform) {
    // Off a supported site the page readers have nothing to read, but a collection still can —
    // it opens its own tab. Offering the marketplaces as buttons keeps that reachable instead of
    // making you navigate somewhere first just to find the button.
    main.innerHTML = `
      <p class="muted">Not on a marketplace page. Collect from:</p>
      <div class="buttons stack">${reg.platforms
        .map((p) => `<button class="ghost pick" data-id="${escape(p.id)}">${escape(p.label)}</button>`)
        .join("")}</div>`;
    for (const button of document.querySelectorAll(".pick")) {
      button.addEventListener("click", () => renderCollect(button.dataset.id));
    }
    return;
  }

  // Which kind of page, asked of the platform itself. Answers "signed_out" or "blocked" before it
  // answers a page type, because that is the useful reply — and because the login page really isn't a
  // page we read, so the generic decline below would be true and useless at the same time.
  const kind = await readPage("whichPage");

  if (kind === "signed_out" || kind === "blocked") {
    main.innerHTML = `
      <p class="error">${
        kind === "signed_out"
          ? `You're not signed in to ${escape(reg.label)}.`
          : `${escape(reg.label)} served a challenge page instead of the content.`
      }</p>
      <p class="muted small">${
        kind === "signed_out"
          ? "Sign in in this tab, then reopen this."
          : "Leave it a while before trying again, and keep the collector at one page at a time."
      }</p>
      <div class="buttons"><button id="again" class="ghost">Try again</button></div>`;
    $("again").addEventListener("click", () => start());
    return;
  }

  if (!kind || kind === "other") {
    main.innerHTML = `
      <p class="muted">This ${escape(reg.label)} page isn't one AutoLancers reads directly.</p>
      <ul class="pages">${PAGE_KINDS.map(
        (k) => `<li><b>${escape(k.label)}</b></li>`
      ).join("")}</ul>
      <div class="buttons"><button id="collect" class="ghost">Collect my ${escape(
        reg.label
      )} pages…</button></div>`;
    $("collect").addEventListener("click", () => renderCollect());
    return;
  }

  main.innerHTML = `<p class="muted">Reading the ${kind === "job" ? "job" : "profile"}…</p>`;
  try {
    const data = await readPage(kind === "job" ? "readJob" : "readProfile");
    if (!data) throw new Error("Nothing came back — try reloading the page first.");
    if (data.error) throw new Error(data.error);
    renderScraped(data, kind);
  } catch (err) {
    main.innerHTML = `<p class="error">${escape(err.message)}</p>
      <div class="buttons"><button id="again">Try again</button></div>`;
    $("again").addEventListener("click", () => start());
  }
}

$("settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

/**
 * Never leave the placeholder on screen.
 *
 * `start()` sets the first thing you see, so anything thrown before that point leaves "Reading the
 * page…" sitting there forever — indistinguishable from a slow page, and the least useful thing a
 * failure can look like. A missing identifier after a bad edit did exactly that.
 */
function fail(err) {
  main.innerHTML = `
    <p class="error">${escape(err?.message || String(err))}</p>
    <p class="muted small">If this followed an update, reload the extension at
      <code>chrome://extensions</code>.</p>
    <div class="buttons"><button id="retry" class="ghost">Try again</button></div>`;
  $("retry")?.addEventListener("click", () => void start().catch(fail));
}

window.addEventListener("unhandledrejection", (e) => fail(e.reason));
window.addEventListener("error", (e) => fail(e.error || e.message));

void start().catch(fail);
