/**
 * Page readers, injected on demand.
 *
 * This file is never declared as a `content_script`. It is injected by the popup, into the tab you
 * are already looking at, when you click — so nothing here runs in the background and nothing
 * crawls. That is a deliberate constraint, not an oversight: Upwork's automation policy is aimed at
 * tools that watch the site for you, and enforcement lands on the user's own account.
 *
 * Everything is read defensively. Marketplace markup changes without notice, so each field tries
 * structured data first, then a stable-looking attribute, then the text next to a visible label —
 * and returns null when it genuinely cannot tell. A null means "not found" and the backend skips
 * that filter. Guessing a zero would silently reject a job for having no budget.
 */

/**
 * Injected more than once per page, so it must be idempotent.
 *
 * A classic script's top-level `const` cannot be declared twice, and the second injection threw
 * "Identifier 'OVERLAY' has already been declared" — which kills the whole file, so every reader
 * vanished after the first click. Guarding on the namespace makes re-injection a no-op, and hanging
 * the readers off `globalThis` is what lets a separately-injected function find them at all.
 */
globalThis.ALExtract ||= (() => {
  const { platformFor, currentPlatform } = globalThis.ALPlatforms;

/** Every JSON-LD block on the page, parsed and flattened. Ignores malformed ones. */
function structuredData() {
  const out = [];
  for (const tag of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(tag.textContent);
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      if (parsed && Array.isArray(parsed["@graph"])) out.push(...parsed["@graph"]);
    } catch {
      // A single unparseable block must not cost us the rest.
    }
  }
  return out;
}

function firstOf(selectors) {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const text = node?.textContent?.trim();
    if (text) return clean(text);
  }
  return null;
}

function textOfAll(selectors, limit = 100) {
  for (const selector of selectors) {
    const values = [...document.querySelectorAll(selector)]
      .map((n) => clean(n.textContent))
      .filter(Boolean);
    if (values.length) return [...new Set(values)].slice(0, limit);
  }
  return [];
}

function clean(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The text sitting next to a visible label.
 *
 * Upwork renders most statistics as a label/value pair with no stable attribute on either — "Total
 * earnings" above "$40K", "Job Success" beside "98%". Matching on the words a human reads survives
 * a class-name change, which is the most common kind of drift.
 */
function nearLabel(label, { after = 120 } = {}) {
  const body = document.body?.innerText || "";
  const at = body.search(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  if (at === -1) return null;
  const window_ = body.slice(at, at + after).replace(new RegExp(label, "i"), "");
  return clean(window_.split("\n").filter(Boolean)[0] || "") || null;
}

/** First number in a string, tolerating $, commas, K/M suffixes and ranges. Null if none. */
function toNumber(text) {
  if (text === null || text === undefined) return null;
  const raw = String(text).replace(/,/g, "");
  const match = raw.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  if (/\dK/i.test(raw)) return value * 1_000;
  if (/\dM/i.test(raw)) return value * 1_000_000;
  return value;
}

/** Both numbers in "$500.00 - $1,000.00", or [n, n] for a single figure. */
function toRange(text) {
  if (!text) return [null, null];
  const found = String(text).replace(/,/g, "").match(/\d+(\.\d+)?/g);
  if (!found) return [null, null];
  const numbers = found.map(Number);
  if (numbers.length === 1) return [numbers[0], numbers[0]];
  return [Math.min(...numbers), Math.max(...numbers)];
}

function currencyOf(text) {
  if (/£/.test(text || "")) return "GBP";
  if (/€/.test(text || "")) return "EUR";
  if (/₹/.test(text || "")) return "INR";
  return "USD";
}

/**
 * Upwork ids look like `~021234567890123456789` and appear in the path on every URL shape the site
 * uses. The id is what dedupes against an already-stored row, so a wrong one means a duplicate
 * rather than an update.
 */
function idFromUrl(href) {
  const platform = platformFor(href) || currentPlatform();
  if (platform) {
    const id = platform.jobId(href);
    if (id) return id;
  }
  // Fallback for a link whose host we can't resolve — a relative href on a page we do know.
  const tilde = href.match(/~[0-9a-zA-Z]{10,}/);
  if (tilde) return tilde[0];
  const numeric = href.match(/[-/](\d{6,})(?:\/|$|\?)/);
  return numeric ? numeric[1] : null;
}

/**
 * Open Graph and meta tags.
 *
 * Worth trying before giving up on a field: these are written for crawlers and social previews, so
 * they survive redesigns that move every class name on the page.
 */
function meta(...names) {
  for (const name of names) {
    const node = document.querySelector(
      `meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`
    );
    const value = clean(node?.getAttribute("content"));
    if (value) return value;
  }
  return null;
}

/**
 * A href as an absolute URL.
 *
 * Resolved against the current page rather than against the origin. Almost every link here is
 * root-relative (`/jobs/~021…`) and the two agree on those, but a genuinely relative href —
 * `settings/contactInfo` next to `/freelancers/` — resolves to the wrong path against a bare origin.
 */
function absolute(url) {
  if (!url) return null;
  try {
    return new URL(url, location.href).href;
  } catch {
    return null;
  }
}

/**
 * The same job, written the same way every time.
 *
 * Upwork links to a posting in two shapes — `/jobs/~021…` and
 * `/jobs/Some-Slug_~021…/` — and hangs a `referrer_url_path` on both, which differs by whichever
 * page you came from. Left alone, one job collected from Best matches and again from Saved jobs
 * yields two different URLs for the same thing, and the tracking parameter records where we had
 * been. Dropping the query and the trailing slash gives one canonical form.
 */
function canonicalJobUrl(url) {
  const absolute_ = absolute(url);
  if (!absolute_) return null;
  try {
    const parsed = new URL(absolute_);
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.href;
  } catch {
    return absolute_;
  }
}


/**
 * The elements between a heading and the next heading of the same or higher rank.
 *
 * `closest()` was the obvious approach and it was wrong: it climbs to whatever wrapper happens to
 * contain the heading, which on a real profile was the entire sidebar — so asking for "Education"
 * returned every item in the "complete your profile" checklist. A heading owns the content that
 * follows it until the next heading of equal or greater rank, and nothing else.
 */
const OVERLAY = "[class*='popper'], [class*='popover'], [class*='tooltip'], [role='tooltip'], [role='dialog'], nav, header, footer";

/** Overlay and navigation chrome is not document structure — it must not split or fill a section. */
function isChrome(node) {
  return Boolean(node.closest(OVERLAY));
}

function sectionNodes(pattern) {
  const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(
    (node) => !isChrome(node)
  );
  const index = headings.findIndex((node) =>
    new RegExp(`^\\s*${pattern}\\s*$`, "i").test(clean(node.textContent))
  );
  if (index === -1) return [];

  const start = headings[index];
  const rank = Number(start.tagName[1]);
  const stop = headings.slice(index + 1).find((node) => Number(node.tagName[1]) <= rank) || null;

  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let inRange = false;
  let node;
  while ((node = walker.nextNode())) {
    if (node === start) {
      inRange = true;
      continue;
    }
    if (!inRange) continue;
    if (stop && (node === stop || stop.contains(node))) break;
    if (!isChrome(node)) out.push(node);
  }
  return out;
}

/** Matching elements inside one heading's section. */
function inSection(pattern, selector) {
  return sectionNodes(pattern).filter((node) => node.matches(selector));
}

/** Text of every heading matching a pattern — used where each entry is its own heading. */
function headingsMatching(regex, limit = 25) {
  return [...document.querySelectorAll("h3, h4, h5")]
    .map((n) => clean(n.textContent))
    .filter((text) => regex.test(text))
    .slice(0, limit);
}

/** The first heading whose text matches, anywhere on the page. */
function headingLike(regex) {
  for (const node of document.querySelectorAll("h1, h2, h3, h4")) {
    const text = clean(node.textContent);
    if (regex.test(text)) return text;
  }
  return null;
}

/**
 * Upwork's <title> is "Name - Tagline - Upwork Freelancer from City, Country".
 *
 * Written for search engines, so it outlives redesigns that move every element on the page — and
 * it carries the tagline, which has no attribute of its own.
 */
function fromTitle() {
  const parts = clean(document.title).split(/\s+-\s+/);
  const where = parts.find((p) => /Upwork Freelancer from/i.test(p)) || "";
  const [city, country] = where.replace(/.*from\s*/i, "").split(/,\s*/);
  return {
    name: parts[0] || null,
    tagline: parts.length > 2 ? parts[1] : null,
    city: clean(city) || null,
    country: clean(country) || null,
  };
}

// --- job -----------------------------------------------------------------------------

function readJob() {
  const url = canonicalJobUrl(location.href) || location.href.split("?")[0];
  const externalId = idFromUrl(url);
  if (!externalId) {
    return { error: "This doesn't look like a job page — no job id in the URL." };
  }

  const posting = structuredData().find((d) => d && /JobPosting/i.test(d["@type"] || "")) || {};
  const pageText = document.body?.innerText || "";

  const description =
    clean((posting.description || "").replace(/<[^>]+>/g, " ")) ||
    firstOf([
      '[data-test="job-description-text"]',
      '[data-test="Description"]',
      "section[aria-labelledby*='description']",
    ]) ||
    "";

  const budgetText = firstOf([
    '[data-test="BudgetAmount"]',
    '[data-test="budget"]',
    '[data-test="job-type-label"] + div',
  ]);
  const typeLabel = firstOf(['[data-test="job-type-label"]', '[data-test="job-type"]']);
  const hourly = /hourly/i.test(typeLabel || pageText.slice(0, 4000));
  const [budgetMin, budgetMax] = toRange(budgetText);

  const proposalsText = firstOf(['[data-test="proposals-tier"]', '[data-test="ClientActivity"] li']);
  const proposalMatch = pageText.match(/Proposals[^0-9]{0,40}(\d+)\s*(?:to|–|-)?\s*(\d+)?/i);

  return {
    platform: currentPlatform()?.id || "unknown",
    external_id: externalId,
    url,
    title:
      posting.title ||
      firstOf(['[data-test="job-title"]', "header h1", "h1"]) ||
      meta("og:title") ||
      clean(document.title.replace(/\s*[-|]\s*Upwork.*$/i, "")),
    description: description.slice(0, 20000),
    skills: textOfAll([
      '[data-test="token"] span',
      '[data-test="skills"] a',
      'a[href*="/nx/search/jobs/?q="]',
    ]),

    // Terms
    work_type: hourly ? "hourly" : budgetMin !== null ? "fixed" : null,
    budget_min: budgetMin,
    budget_max: budgetMax,
    currency: currencyOf(budgetText),
    experience_level: firstOf(['[data-test="expertise"]', '[data-test="contractor-tier"]']) ||
      nearLabel("Experience Level"),
    project_length: firstOf(['[data-test="duration"]']) || nearLabel("Project Length|Duration"),
    hours_per_week: nearLabel("Hourly|hrs/week", { after: 60 }),
    connects_required: toNumber(nearLabel("Connects required|Send a proposal for")),
    category: firstOf(['[data-test="category"]', '[data-test="job-category"]']),

    // Competition, which the backend scores rather than gates on
    proposal_count:
      toNumber(proposalsText) ?? (proposalMatch ? Number(proposalMatch[2] || proposalMatch[1]) : null),
    interviewing: toNumber(nearLabel("Interviewing")),
    invites_sent: toNumber(nearLabel("Invites sent")),
    unanswered_invites: toNumber(nearLabel("Unanswered invites")),
    last_viewed_by_client: nearLabel("Last viewed by client"),

    posted_at: posting.datePosted || null,
    posted_text: nearLabel("Posted", { after: 60 }),

    // Who is hiring. A client's history predicts whether a bid is worth the connects, so it's part
    // of the posting rather than a separate lookup.
    client: {
      country: firstOf(['[data-test="client-country"]', '[data-test="LocationLabel"]']),
      city: firstOf(['[data-test="client-city"]']),
      rating: toNumber(firstOf(['[data-test="buyer-rating"]', '[data-test="client-rating"]'])),
      reviews: toNumber(nearLabel("reviews?", { after: 40 })),
      total_spent: toNumber(firstOf(['[data-test="client-spend"]']) || nearLabel("total spent")),
      total_hires: toNumber(nearLabel("hires?", { after: 40 })),
      active_hires: toNumber(nearLabel("active")),
      jobs_posted: toNumber(nearLabel("jobs posted")),
      hire_rate: nearLabel("hire rate"),
      avg_hourly_paid: toNumber(nearLabel("/hr avg hourly rate paid")),
      member_since: firstOf(['[data-test="client-contract-date"]']) || nearLabel("Member since"),
      payment_verified: /payment (method )?verified/i.test(pageText),
      company_size: nearLabel("employees|company size"),
      industry: firstOf(['[data-test="client-industry"]']),
    },
  };
}

// --- freelancer profile --------------------------------------------------------------

/** Repeated blocks — portfolio items, past jobs, employment — as arrays of small objects. */
function blocks(containerSelectors, mapper, limit = 25) {
  for (const selector of containerSelectors) {
    const nodes = [...document.querySelectorAll(selector)].slice(0, limit);
    if (nodes.length) {
      const mapped = nodes.map(mapper).filter((entry) => Object.values(entry).some(Boolean));
      if (mapped.length) return mapped;
    }
  }
  return [];
}

function readProfile() {
  const url = location.href.split("?")[0];
  const username =
    (url.match(/~[0-9a-zA-Z]{10,}/) || [])[0] ||
    (url.match(/\/(?:freelancers?|freelancer)\/([^/?]+)/) || [])[1] ||
    (url.match(/^https?:\/\/[^/]+\/([A-Za-z0-9_.-]+)\/?$/) || [])[1];
  if (!username) {
    return { error: "Open a freelancer profile page first." };
  }

  const session = sessionState();
  if (session.status !== "ok") {
    return { status: session.status, error: `Not signed in — ${session.why}.` };
  }

  const titled = fromTitle();

  // "$20.00/hr" is its own heading with nothing else identifying it, so match the shape.
  const rateText = firstOf(['[itemprop="priceRange"]']) || headingLike(/^[$£€₹][\d,.]+\s*\/\s*hr/i);

  const skills = (() => {
    const scoped = inSection("Skills", ".air3-token, [class*='token']")
      .map((n) => clean(n.textContent))
      .filter(Boolean);
    return scoped.length ? [...new Set(scoped)] : textOfAll([".air3-token"], 60);
  })();

  return {
    platform: currentPlatform()?.id || "unknown",
    username,
    url,
    status: "ok",

    /**
     * Whether this is the signed-in user's own profile, by account id rather than by name.
     *
     * The backend mirrors a captured profile onto *your* `freelancer_profiles` row, so a stranger's
     * profile sent here overwrites your name, rate, tagline and skills with theirs. `null` means
     * undecidable — no header link to compare against — and the backend treats that as "not proven
     * mine" and refuses, rather than picking the convenient answer.
     */
    is_own: isOwnProfile(),

    // Identity — itemprop survived every redesign so far; the title is the backstop.
    display_name: firstOf(['[itemprop="name"]']) || titled.name,
    tagline: headingLike(/^(?!.*\/hr)[A-Z][^$]{8,90}(Engineer|Developer|Designer|Consultant|Specialist|Manager|Architect|Writer|Marketer)/) ||
      titled.tagline,
    summary: firstOf(['[itemprop="description"]', '[data-cy="about-me-section"] p']) ||
      meta("description", "og:description"),
    avatar_url:
      absolute(document.querySelector('img[alt*="profile" i], [class*="avatar"] img')?.src) ||
      meta("og:image"),
    country: firstOf(['[itemprop="country-name"]']) || titled.country,
    city: firstOf(['[itemprop="locality"]']) || titled.city,
    timezone: nearLabel("local time|Timezone"),
    availability: nearLabel("Availability|hrs/week"),
    languages: [...new Set(
      inSection("Languages", "li, .air3-token").map((n) => clean(n.textContent)).filter(Boolean)
    )].slice(0, 20),

    // Money
    hourly_rate: toNumber(rateText),
    currency: currencyOf(rateText),
    total_earnings: toNumber(nearLabel("Total earnings")),

    // Track record
    rating: toNumber(nearLabel("Job Success|rating", { after: 30 })),
    total_reviews: toNumber(nearLabel("reviews?", { after: 30 })),
    job_success: toNumber(nearLabel("Job Success", { after: 30 })),
    total_jobs: toNumber(nearLabel("Total jobs")),
    total_hours: toNumber(nearLabel("Total hours")),

    skills,

    portfolio: (() => {
      const links = inSection("Portfolio", "a[href]");
      if (!links.length) return [];
      return links
        .map((a) => ({
          title: clean(a.getAttribute("aria-label") || a.textContent) || null,
          url: absolute(a.getAttribute("href")),
          image: absolute(a.querySelector("img")?.getAttribute("src")),
        }))
        .filter((entry) => entry.title || entry.image)
        .slice(0, 25);
    })(),

    work_history: [...new Set(
      inSection("Work history", "h4, h5, li")
        .map((node) => clean(node.textContent))
        .filter((text) => text && text.length > 3)
    )]
      .slice(0, 25)
      .map((title) => ({ title })),

    // Each role is one heading, "Software Engineer - III | Ebay". Splitting on the pipe is what
    // separates the role from the employer; without it both collapse into one string.
    employment: headingsMatching(/\|/).map((text) => {
      const [role, company] = text.split("|").map(clean);
      return { title: role || null, company: company || null };
    }),

    education: [...new Set(
      inSection("Education", "h4, h5, li").map((n) => clean(n.textContent)).filter(Boolean)
    )]
      .slice(0, 10)
      .map((school) => ({ school })),

    certifications: [...new Set(
      inSection("Certifications", "h4, h5, li")
        .map((n) => clean(n.textContent))
        .filter((text) => text && !/Earn \d+ Connects|Claim certification/i.test(text))
    )].slice(0, 20),
  };
}

// --- diagnostics --------------------------------------------------------------------

/**
 * A structural fingerprint of the page, for when the readers come back empty.
 *
 * Upwork returns 403 to anything but a real browser, so their live markup cannot be inspected from
 * a terminal — this is the only way to see what the selectors are actually up against. It reports
 * attribute names and short text samples, never the full page.
 */
function diagnose() {
  const attributes = {};
  for (const name of ["data-test", "data-qa", "data-cy", "itemprop"]) {
    const seen = {};
    for (const node of document.querySelectorAll(`[${name}]`)) {
      const key = node.getAttribute(name);
      if (!key) continue;
      if (!seen[key]) {
        seen[key] = { count: 0, sample: clean(node.textContent).slice(0, 70) };
      }
      seen[key].count += 1;
    }
    if (Object.keys(seen).length) attributes[name] = seen;
  }

  const headings = [...document.querySelectorAll("h1, h2, h3, h4")]
    .map((n) => `${n.tagName.toLowerCase()}: ${clean(n.textContent).slice(0, 80)}`)
    .filter((h) => h.length > 4)
    .slice(0, 40);

  // Repeated class names are where the list blocks live — portfolio tiles, work history rows.
  const classCounts = {};
  for (const node of document.querySelectorAll("[class]")) {
    for (const cls of node.classList) {
      if (/^(air3|up-|d-|mt-|mb-|p-|m-)/.test(cls) === false) continue;
      classCounts[cls] = (classCounts[cls] || 0) + 1;
    }
  }
  const repeated = Object.entries(classCounts)
    .filter(([, n]) => n >= 3 && n <= 60)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  return {
    url: location.href.split("?")[0],
    title: document.title,
    attribute_counts: Object.fromEntries(
      Object.entries(attributes).map(([k, v]) => [k, Object.keys(v).length])
    ),
    attributes,
    headings,
    repeated_classes: Object.fromEntries(repeated),
    // If this is tiny, the page renders client-side and the reader ran too early.
    body_text_length: (document.body?.innerText || "").length,
    json_ld_types: structuredData().map((d) => d["@type"]).filter(Boolean),
  };
}

/**
 * The page as a person reads it, with chrome stripped.
 *
 * Sent to the LLM reader. `innerText` rather than `innerHTML` on purpose: markup is what keeps
 * breaking, and the model only needs what a human sees. It is also an order of magnitude fewer
 * tokens, which is the difference between one cheap call and a hundred expensive ones.
 */
function readText() {
  const clone = document.body.cloneNode(true);
  for (const node of clone.querySelectorAll(`script, style, ${OVERLAY}`)) node.remove();
  return {
    url: location.href.split("?")[0],
    title: document.title,
    text: clean(clone.innerText || "").slice(0, 60000),
  };
}

// --- list pages ---------------------------------------------------------------------

/** Card lines that are terms or stats, not prose — everything a description is not. */
const CARD_META =
  /^(?:\$|£|€|₹)|^(?:Fixed[- ]price|Hourly|Proposals?|Posted|Payment (?:method )?verified|Est\.|Budget|Entry|Intermediate|Expert|Less than|More than|\d+\s*(?:to|-)\s*\d+|[\d.]+\s*\/\s*hr|\d+\+?\s*(?:hrs?|hours?)|Rating|Spent|United |Remote|Contract|Ongoing|One[- ]time)/i;

/**
 * The description a card actually shows, separated from the terms around it.
 *
 * The whole card's text was being returned as a "snippet", so every description arrived with the
 * budget, the proposal count and the posted date glued to the front of it. A description is the one
 * block of prose on the card: not the title, not a line that starts with money or a stat, and long
 * enough to be a sentence rather than a label.
 *
 * Listing pages truncate this — Upwork shows a preview with a "more" link. What comes back here is
 * that preview, honestly. The full text needs the job's own page.
 */
function cardDescription(card, title) {
  if (!card) return null;

  const blocks = [...card.querySelectorAll("p, span, div")]
    // Leaf-ish only: a wrapper repeats everything its children already said.
    .filter((node) => !node.querySelector("p, span, div"))
    .map((node) => clean(node.textContent))
    .filter(
      (text) =>
        text &&
        text !== title &&
        text.length >= 60 &&
        !CARD_META.test(text) &&
        // Prose has sentences; a run of skill chips does not.
        /[a-z]{3,}\s+[a-z]{3,}/i.test(text)
    );

  if (!blocks.length) return null;
  // The longest qualifying block is the description; shorter ones are labels that slipped through.
  return blocks.sort((a, b) => b.length - a.length)[0];
}

/**
 * Job cards on any listing page — best matches, most recent, saved, invites.
 *
 * Anchored on the links themselves rather than on a card class. Every listing page differs in
 * markup but they all agree on one thing: a job is a link to `/jobs/~id`. Walking outward from the
 * link to its enclosing card is the only part that has to hold.
 */
function readJobCards(limit = 60) {
  const seen = new Set();
  const cards = [];

  const platform = currentPlatform();
  const selector = platform?.jobLink || 'a[href*="/jobs/"]';

  for (const anchor of document.querySelectorAll(selector)) {
    if (isChrome(anchor)) continue;

    const href = canonicalJobUrl(anchor.getAttribute("href"));
    // The path is matched before the query, so a `referrer_url_path` carrying a different job's id
    // cannot win — but canonicalising first removes the question entirely.
    const id = idFromUrl(href || "");
    if (!id || seen.has(id)) continue;

    const card =
      anchor.closest("article, section, li, [class*='job-tile'], [class*='card']") ||
      anchor.parentElement;
    const text = clean(card?.innerText || "");

    // The card text carries the terms as a human reads them; pull the shapes worth having and
    // leave the rest as `snippet` rather than inventing structure that isn't there.
    const budget = text.match(/[$£€₹][\d,.]+(?:\s*-\s*[$£€₹][\d,.]+)?/);
    const proposals = text.match(/Proposals:?\s*(\d+)\s*(?:to|–|-)\s*(\d+)|Proposals:?\s*(\d+)/i);

    const title = clean(anchor.textContent) || null;
    const description = cardDescription(card, title);

    seen.add(id);
    cards.push({
      external_id: id,
      url: href,
      title,
      // Truncated by the marketplace, not by us. `description_complete` says which you're holding,
      // so nothing downstream treats a preview as the whole posting.
      description,
      description_complete: false,
      budget: budget ? budget[0] : null,
      proposals: proposals ? Number(proposals[2] || proposals[1] || proposals[3]) : null,
      posted: (text.match(/\b\d+\s*(?:minute|hour|day|week|month)s?\s*ago\b/i) || [null])[0],
      skills: [...new Set(
        [...(card?.querySelectorAll(".air3-token, [class*='token']") || [])]
          .map((n) => clean(n.textContent))
          .filter(Boolean)
      )].slice(0, 15),
    });
    if (cards.length >= limit) break;
  }
  return cards;
}

/** Contract and report rows: a link plus the row's text, with no assumption about the columns. */
function readRows(pattern, limit = 60) {
  const rows = [];
  for (const anchor of document.querySelectorAll("a[href]")) {
    if (isChrome(anchor)) continue;
    const href = absolute(anchor.getAttribute("href")) || "";
    if (!pattern.test(href)) continue;
    const row = anchor.closest("tr, li, article, [class*='row'], [class*='card']") || anchor.parentElement;
    const title = clean(anchor.textContent);
    if (!title) continue;
    rows.push({ title, url: href, detail: clean(row?.innerText || "").slice(0, 240) || null });
    if (rows.length >= limit) break;
  }
  return rows;
}

/**
 * Message rooms — the list only.
 *
 * Deliberately metadata: who and when, plus whatever preview the list itself renders. This does not
 * open a conversation or read its history. Those are two-party messages, and half of that data
 * belongs to someone who never agreed to any of this.
 */
function readMessageRooms(limit = 50) {
  const rooms = [];
  const nodes = document.querySelectorAll(
    "[class*='room-list'] li, [class*='conversation'] li, [role='listitem'], li"
  );
  for (const node of nodes) {
    if (isChrome(node)) continue;
    const text = clean(node.innerText || "");
    if (text.length < 3 || text.length > 400) continue;
    const when = (text.match(/\b\d+\s*(?:m|h|d|w|mo)\b|\b\d{1,2}:\d{2}\s*(?:AM|PM)?/i) || [null])[0];
    rooms.push({ preview: text.slice(0, 200), when });
    if (rooms.length >= limit) break;
  }
  return rooms;
}

/**
 * Get to a page by clicking a link on the current one, the way a person would.
 *
 * Upwork is a single-page app: its own nav links are handled by the client router, so following one
 * re-renders without a document request. Navigating by URL instead forces a full load every time,
 * which is both slower and a far more obvious pattern than someone clicking around.
 *
 * Returns what happened rather than throwing, so the caller can fall back to a real navigation when
 * the link simply is not on this page.
 */
function clickTo(fragment) {
  const before = location.href;

  // Already here. Clicking the link for the page you are on changes no URL, and a router that does
  // nothing gives nothing to wait for — which read as a hang rather than "we have arrived".
  if (location.pathname.replace(/\/+$/, "").includes(fragment.replace(/\/+$/, ""))) {
    return { clicked: false, already: true, before };
  }

  const candidates = [...document.querySelectorAll("a[href]")].filter((anchor) => {
    const href = anchor.getAttribute("href") || "";
    if (!href.includes(fragment)) return false;
    // A hidden or zero-size link is not something a person could have clicked.
    const box = anchor.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });

  if (!candidates.length) return { clicked: false, reason: `no visible link to ${fragment}`, before };

  // Prefer a link in the page's own navigation over one buried in a card or the footer.
  const target =
    candidates.find((a) => a.closest("nav, [role='navigation'], [class*='nav']")) || candidates[0];

  target.scrollIntoView({ block: "center" });
  target.click();
  return { clicked: true, before, href: target.href };
}

/**
 * Wait for the client router to finish, without assuming a document load happened.
 *
 * A SPA route change fires no load event, so there is nothing to listen for — the URL changing and
 * the content settling is the only signal. Resolves early once both have happened.
 */
function afterRouteChange(previousUrl, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let lastLength = null;
    let stableFor = 0;

    const tick = () => {
      const moved = location.href !== previousUrl;
      const length = (document.body?.innerText || "").length;

      // Settled means the text stopped changing — not that it passed some size. A page with one
      // saved job is legitimately short, and a length threshold would call it a failure forever.
      stableFor = length === lastLength ? stableFor + 200 : 0;
      lastLength = length;

      if (moved && length > 0 && stableFor >= 600) {
        return resolve({ ok: true, url: location.href });
      }
      if (Date.now() - started > timeoutMs) {
        return resolve({ ok: false, url: location.href, moved, length });
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

/**
 * Whether this page is the thing we asked for, or a wall standing in front of it.
 *
 * The failure this exists to prevent: signed out of Upwork, every find-work URL redirects to the
 * login page. That page loads fine, so the tab reaches `complete`, and the job reader finds no
 * `/jobs/~id` links on it and returns an empty list. The run then reports **"0 found" on all eight
 * pages** — which reads exactly like a quiet day on the marketplace, and files "stored 0" to the
 * backend as though that were true. An empty list from a login page is not a small inaccuracy; it is
 * worse than an error, because nothing downstream can tell it from the truth.
 *
 * Three states, because they need different things from you:
 *
 *   `signed_out` — sign in, then collect again.
 *   `blocked`    — a challenge or a rate limit. Stop: more pages makes it worse, and this is the bot
 *                  detection whose signature is documented in `src/background/worker.js`.
 *   `ok`         — read it.
 *
 * The URL is checked first because a redirect is unambiguous, then the page's own content — a
 * marketplace can render a login wall in place without changing the URL, so both halves are needed.
 */
function sessionState() {
  const platform = currentPlatform();
  const text = (document.body?.innerText || "").slice(0, 4000);

  if (platform?.isLoginPage?.(location.href)) {
    return { status: "signed_out", why: "redirected to the login page" };
  }

  // A password field is as close to proof as this gets: no signed-in marketplace page has one
  // outside of settings, and the collector never visits settings.
  const asksForPassword = Boolean(document.querySelector('input[type="password"]'));
  const invitesSignIn = /\b(log ?in|sign ?in|welcome back)\b/i.test(text.slice(0, 1200));
  if (asksForPassword && invitesSignIn) {
    return { status: "signed_out", why: "the page is asking you to sign in" };
  }

  // Upwork's challenge page. The wording is theirs — it is what appeared when eight pages were read
  // at once, and recognising it is what lets the run stop instead of hammering through the rest.
  if (
    /there was an error loading this page|please contact customer support/i.test(text) ||
    /access denied|unusual (?:traffic|activity)|are you a (?:human|robot)|verify you are human/i.test(text) ||
    /^just a moment/i.test(document.title)
  ) {
    return { status: "blocked", why: "served a challenge page instead" };
  }

  return { status: "ok", why: null };
}

/**
 * One entry point the collector calls with the page key it navigated to.
 *
 * Which reader runs comes from the page's own `reads` declaration in the platform registry, not
 * from a list of key names — so adding a marketplace does not mean editing a switch here.
 */
function readList(key) {
  const platform = currentPlatform();
  const page = platform?.pages.find((p) => p.key === key);
  const base = {
    key,
    platform: platform?.id || "unknown",
    url: location.href.split("?")[0],
    title: document.title,
    at: new Date().toISOString(),
    status: "ok",
  };

  // Checked before any reader runs, so a wall can never be mistaken for an empty result.
  const session = sessionState();
  if (session.status !== "ok") {
    return {
      ...base,
      status: session.status,
      count: 0,
      error:
        session.status === "signed_out"
          ? `Not signed in to ${platform?.label || "this site"} — ${session.why}.`
          : `${platform?.label || "This site"} ${session.why}.`,
    };
  }

  switch (page?.reads) {
    case "jobs": {
      const jobs = readJobCards();
      return { ...base, count: jobs.length, jobs };
    }
    case "rows": {
      // Same-host links only. A row is a link to a detail page; anything off-site is an advert or
      // a help article, and `/./` would have swept in both.
      const rows = readRows(new RegExp(`^https?://[^/]*${location.hostname.replace(/\./g, "\\.")}/`));
      return {
        ...base,
        count: rows.length,
        rows,
        text: clean(document.body.innerText).slice(0, 3000),
      };
    }
    case "rooms": {
      const rooms = readMessageRooms();
      return { ...base, count: rooms.length, rooms };
    }
    default:
      return { ...base, error: `No reader configured for ${key}` };
  }
}

/**
 * The signed-in user's own profile URL, taken from the site's own navigation.
 *
 * "Which profile is mine?" has no stable answer from a URL pattern — `upwork.com/freelancers/~01…`
 * matches everybody's. But the marketplace itself knows, and it puts a link to *your* profile in its
 * own header: that is what the avatar menu opens. Following the site's own link is the same trick the
 * rest of this file uses for fields, and it needs nothing configured.
 *
 * Returns `null` rather than guessing when the header has no such link — signed out, or a redesign.
 * A guess here is the expensive kind of wrong: the profile it names gets written into your own
 * profile row.
 */
function findOwnProfile() {
  const platform = currentPlatform();
  if (!platform?.ownProfileLink) return null;

  const session = sessionState();
  if (session.status !== "ok") return { status: session.status, url: null, id: null };

  // Header and account menus only. A profile link inside a job card or a review is *someone else's*,
  // and that is the whole distinction being drawn here.
  const scopes = [
    "header",
    "[data-test*='user-menu']",
    "[class*='user-menu']",
    "[class*='account-menu']",
    "[aria-label*='account' i]",
    "nav",
  ];

  for (const scope of scopes) {
    for (const container of document.querySelectorAll(scope)) {
      for (const anchor of container.querySelectorAll(platform.ownProfileLink)) {
        const url = absolute(anchor.getAttribute("href"));
        if (!url || !platform.isProfilePage(url)) continue;
        return { status: "ok", url: url.split("?")[0], id: platform.profileId?.(url) || null };
      }
    }
  }
  return { status: "not_found", url: null, id: null };
}

/**
 * Is the profile page we are on the signed-in user's own?
 *
 * Compared by the account id in the URL against the id the header links to. Not by name, and not by
 * the presence of an "Edit profile" button — both move; the id does not.
 *
 * `null` means undecidable (no header link to compare against), which the caller must treat as "not
 * proven mine" rather than as either answer.
 */
function isOwnProfile() {
  const platform = currentPlatform();
  const mine = findOwnProfile();
  if (!mine || mine.status !== "ok" || !mine.id) return null;
  const here = platform?.profileId?.(location.href);
  return here ? here === mine.id : null;
}

/** Which of the readers applies here, decided by the platform rather than by the popup. */
function whichPage() {
  const platform = currentPlatform();
  if (!platform) return null;
  // Reported before the page type, because "you are signed out" is the useful answer and "this is
  // not a page I read" is a misleading one — the login page genuinely isn't, but that isn't why.
  const session = sessionState();
  if (session.status !== "ok") return session.status;
  if (platform.isProfilePage(location.href)) return "profile";
  if (platform.isJobPage(location.href)) return "job";
  return "other";
}

  // idFromUrl and canonicalJobUrl are exported for the tests: URL handling is where the two
  // link shapes and the tracking parameter bite, so it is worth pinning directly.
  return {
    readJob, readProfile, diagnose, readText, readList, clickTo, afterRouteChange, whichPage,
    idFromUrl, canonicalJobUrl, sessionState, findOwnProfile, isOwnProfile,
  };
})();
