/**
 * The AutoLancers backend client.
 *
 * The extension stays a reader and a courier. It sends what its selectors found, exactly as they
 * found it — `budget` as the string `"$500.00 - $1,000.00"`, `posted` as `"3 hours ago"` — and the
 * backend parses that into columns. One parser, on the side that owns the schema, rather than two
 * that drift; and the LLM reader lives there too, because the model keys do and always will.
 *
 * Nothing here runs on its own. A push happens because a page finished being read, and a page is
 * only ever read because someone clicked.
 */

/** Where the backend is, and the token to reach it with. Synced, like the rest of Settings. */
const CONNECTION_DEFAULTS = { apiUrl: "http://localhost:8010", token: "" };

/**
 * Push settings, kept in local storage with the other collection settings.
 *
 * `pushToBackend` defaults on because the real gate is the token: with no token configured there is
 * nowhere to send anything and every push short-circuits. Turning the setting off is for someone who
 * has a token and wants to scrape without filing.
 *
 * `useLlm` defaults off because it costs money and seconds per page. The scrapers are free and
 * instant, and this only earns its keep when they come back empty.
 */
export const PUSH_DEFAULTS = { pushToBackend: true, useLlm: false };

const SETTINGS_KEY = "collect.settings";

/** How long to wait on one page's push before giving up on it. */
const PUSH_TIMEOUT_MS = 120_000;

export async function connection() {
  const stored = await chrome.storage.sync.get(Object.keys(CONNECTION_DEFAULTS));
  const { apiUrl, token } = { ...CONNECTION_DEFAULTS, ...stored };
  return { apiUrl: String(apiUrl || "").replace(/\/+$/, ""), token: String(token || "") };
}

export async function pushSettings() {
  const { [SETTINGS_KEY]: stored = {} } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...PUSH_DEFAULTS, ...stored };
}

/**
 * POST JSON to the backend, with the failures named rather than numbered.
 *
 * A 401 and an unreachable server need different fixes, and "Failed to fetch" tells you neither.
 * The LLM pass can legitimately take a minute on a page of sixty jobs, hence the long timeout —
 * but a hung request must still end, or a collection's last page never resolves.
 */
async function post(path, body) {
  const { apiUrl, token } = await connection();
  if (!token) throw new Error("No token configured — see Settings.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("The backend took too long to answer.");
    throw new Error(`Can't reach ${apiUrl} — is the backend running?`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) throw new Error("Token rejected — issue a new one in Settings.");
  if (!response.ok) {
    // FastAPI puts the useful part in `detail`; a validation error puts a list there. Either way the
    // status alone would send someone reading server logs for something the response already said.
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new Error(`Backend answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return response.json();
}

/**
 * The body of one page's push. Separate from sending it so the wire contract can be tested.
 *
 * `is_llm_required` is what tells the backend an LLM reading is wanted for this page — it is a
 * request, not an instruction. The backend still skips the model when the selectors left nothing
 * missing, and the result says whether it actually ran, so an enrichment that quietly did nothing is
 * distinguishable from one that filled twenty fields.
 *
 * Which array `items` comes from is decided by the page's `reads` declaration in the platform
 * registry, the same way the reader itself is chosen — so adding a marketplace does not mean editing
 * a branch here.
 */
export function collectionPayload({ platform, page, result, useLlm, now = null }) {
  const reads = page.reads || "jobs";
  const items =
    reads === "jobs"
      ? result?.jobs || []
      : reads === "rows"
        ? result?.rows || []
        : result?.rooms || [];

  return {
    freelance_platform: result?.platform || platform || "unknown",
    // The signed-in account the page was read under, so the backend attributes the jobs to that
    // account's profile rather than the selected one. Null falls back to selected on the backend.
    account_id: result?.account_id || null,
    page_key: page.key,
    page_label: page.label || "",
    reads,
    page_url: result?.url || page.url || "",
    /**
     * Whether the reader got the page or a wall: `ok`, `signed_out`, `blocked`.
     *
     * Sent because it is the one failure the user can act on, and because the app is what notices the
     * consequence — the board goes stale while the extension quietly reports zero. The frontend is
     * open in the same browser, so that is where "your Upwork session expired" belongs.
     */
    page_status: result?.status || "ok",
    // The reader's own timestamp, from the moment the DOM was read. Relative ages ("3 hours ago")
    // are resolved against it on the backend, so a push that waited does not shift every posted date.
    scraped_at: result?.at || now || new Date().toISOString(),
    // What the wall said, verbatim, so the app can show a reason rather than a status code.
    status_detail: result?.error || "",
    is_llm_required: Boolean(useLlm),
    items,
    // A listing page's text is only sent when the model might read it — 60KB the backend would
    // otherwise ignore. A rows page is the opposite: its text *is* the data, because the rows are a
    // partial reading of it and there is no schema to lose the rest into. Those are accumulated whole
    // for v2, and the reader already bounds that text at 3k characters.
    //
    // Never for a wall: a login page's text is not your contracts, and accumulating it would file
    // junk under a page key that is supposed to mean something.
    page_text:
      (result?.status || "ok") !== "ok" ? "" : useLlm || reads !== "jobs" ? result?.text || "" : "",
  };
}

/**
 * Send one page the collector just finished reading.
 *
 * Per page rather than one payload at the end of the run: a cancelled or half-failed collection
 * keeps whatever it already got, and sixty jobs is a single request either way.
 */
export async function pushPage(args) {
  // Your own profile has its own endpoint and its own rules — it mirrors onto the profile row every
  // score is computed from, so it is gated on `is_own` rather than accepted like a page of listings.
  // Routing it here keeps the collector from needing to know that.
  const reads = args.page?.reads || "jobs";
  if (reads === "profile") {
    const me = args.result?.profile;
    if (!me || me.error) throw new Error(me?.error || "The profile could not be read.");
    const saved = await pushProfile(me, args.useLlm);
    return { stored: 1, created: 1, updated: 0, profile: true, skills: saved?.skills ?? 0 };
  }
  // Jobs go to the listing endpoint; everything else (contracts, proposals, rooms) is kept whole
  // by the custom-pages endpoint. Same body either way — the path is what routes it.
  const path = reads === "jobs" ? "/ingest/job-listing" : "/ingest/custom-pages";
  return post(path, collectionPayload(args));
}

/**
 * Attach the LLM request to a single-page payload the same way `collectionPayload` does: the reader
 * always carries `page_text`, but it is only forwarded when the model is wanted — otherwise it is a
 * large field the backend would ignore. `is_llm_required` is a request, not an instruction; the
 * backend still fills only what the selectors missed and reports whether it ran.
 */
function withLlm(data, useLlm) {
  const { page_text, ...rest } = data || {};
  return { ...rest, is_llm_required: Boolean(useLlm), page_text: useLlm ? page_text || "" : "" };
}

/** A single job page, scored on arrival. The popup's Send button uses it. */
export async function pushPosting(job, useLlm) {
  if (useLlm === undefined) ({ useLlm } = await pushSettings());
  return post("/ingest/ondemand/job-posting", withLlm(job, useLlm));
}

/**
 * A batch of job pages, each read on its own.
 *
 * The deep pass opens one job at a time and used to hold every result until it had read them all —
 * so a run stopped at job 28 of 31 filed nothing, having spent twenty-eight page loads for it.
 * Batching flushes the work as it is done, and what has been read stays read.
 *
 * A batch rather than one request per job because round trips are the only thing being saved: ten
 * postings is one call and one commit either way, and thirty separate calls during a run that is
 * already pacing itself is noise nobody needs.
 *
 * No `withLlm` here. These pages were read whole, from the job's own URL, so there is nothing left
 * for a model to fill — and paying per job for a description already in hand is the one shape of
 * that spend with no upside at all.
 */
export async function pushPostings(postings) {
  if (!postings?.length) return { stored: 0, created: 0, updated: 0 };
  return post("/ingest/job-postings", { postings });
}

/** Your own profile, mirrored onto its profile row. */
export async function pushProfile(profile, useLlm) {
  if (useLlm === undefined) ({ useLlm } = await pushSettings());
  return post("/ingest/profile", withLlm(profile, useLlm));
}

/**
 * One line of a push result, short enough for the checklist.
 *
 * Counts, not a tick. A page whose selectors found twelve links and stored none is a broken
 * selector, and "sent ✓" is precisely the wrong thing to say about it.
 */
export function describePush(summary) {
  if (!summary) return "";
  if (summary.error) return summary.error;
  // A page with no modelled table is kept as a raw capture. Saying "kept" rather than "stored" is the
  // honest word for it: the rows are in the database and queryable, but nothing reads them yet.
  if (summary.capture_id) {
    return `${summary.stored} kept${summary.llm_used ? ` · AI read ${summary.llm_fields_filled}` : ""}${
      summary.updated ? " · unchanged" : ""
    }`;
  }

  if (summary.profile) return `mirrored · ${summary.skills} skills`;

  const parts = [`${summary.stored} stored`];
  if (summary.created !== summary.stored) parts.push(`${summary.created} new`);
  if (summary.duplicates) parts.push(`${summary.duplicates} dup`);
  if (summary.skipped_no_id) parts.push(`${summary.skipped_no_id} no id`);
  if (summary.llm_used) parts.push(`AI filled ${summary.llm_fields_filled}`);
  if (summary.llm_error) parts.push(`AI failed`);
  return parts.join(" · ");
}
