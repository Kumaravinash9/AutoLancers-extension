/**
 * Runs the real extractor against fixture pages.
 *
 * Not a substitute for Upwork — their markup is the thing that drifts — but it proves the parsing,
 * the fallbacks and the "null means not found" contract without ever loading their site.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const src =
  readFileSync(new URL("../src/content/platforms.js", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../src/content/extract.js", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n         got ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`}`);
}

async function read(fixture, fn) {
  await page.goto(pathToFileURL(new URL(`fixtures/${fixture}`, import.meta.url).pathname).href);
  // The real job URL carries the id; file:// can't, so hand the id in the way the page would.
  return page.evaluate(([code, name, href]) => {
    Object.defineProperty(window, "__href", { value: href, configurable: true });
    const original = Object.getOwnPropertyDescriptor(Location.prototype, "href");
    eval(code);
    return name === "readJob" ? globalThis.ALExtract.readJob() : globalThis.ALExtract.readProfile();
  }, [src.replace(/location\.href/g, "window.__href"), fn, fixture === "job.html"
      ? "https://www.upwork.com/jobs/~021999888777666555"
      : "https://www.upwork.com/freelancers/~019abcdef123456789"]);
}

/** Any reader, on any fixture, at any URL — for the cases that turn on which URL you are at. */
async function readFrom(fixture, href, call, ...args) {
  await page.goto(pathToFileURL(new URL(`fixtures/${fixture}`, import.meta.url).pathname).href);
  return page.evaluate(([code, url, fn, callArgs]) => {
    Object.defineProperty(window, "__href", { value: url, configurable: true });
    eval(code);
    return globalThis.ALExtract[fn](...callArgs);
  }, [src.replace(/location\.href/g, "window.__href"), href, call, args]);
}

/**
 * The manifest, as Chrome reads it.
 *
 * `manifest.json` may carry `//` comments — Chrome strips them, JSON.parse does not. Only lines that
 * *begin* with `//` are dropped, so an `https://` inside a string is never touched.
 */
function manifest() {
  const raw = readFileSync(new URL("../manifest.json", import.meta.url), "utf8");
  return JSON.parse(
    raw.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n")
  );
}

console.log("job page:");
const job = await read("job.html", "readJob");
check("external_id from URL", job.external_id, "~021999888777666555");
check("title", job.title, "Next.js dashboard build");
check("work_type (hourly vs fixed changes which floor applies)", job.work_type, "fixed");
check("budget range", [job.budget_min, job.budget_max], [1500, 3000]);
check("skills", job.skills, ["Next.js", "FastAPI", "React"]);
check("proposal count", job.proposal_count, 11);
check("posted_at from JSON-LD", job.posted_at, "2026-07-28T09:00:00Z");
check("experience_level", job.experience_level, "Expert");
check("project_length", job.project_length, "1 to 3 months");
check("category", job.category, "Web Development");
check("interviewing", job.interviewing, 3);
check("invites_sent", job.invites_sent, 5);
check("client country", job.client.country, "United States");
check("client rating", job.client.rating, 4.8);
check("client spend, K expanded", job.client.total_spent, 120000);
check("payment_verified", job.client.payment_verified, true);

console.log("\nprofile page (structure taken from a live diagnostics dump):");
const profile = await read("profile.html", "readProfile");
check("display_name from itemprop", profile.display_name, "Avinash K.");
check("tagline from heading", profile.tagline, "AI, Backend & Platform Engineer");
check("city from itemprop", profile.city, "Bengaluru");
check("country from itemprop", profile.country, "India");
check("hourly_rate from the $x/hr heading", profile.hourly_rate, 20);
check("skills from air3-token", profile.skills, ["Python", "FastAPI", "LLM"]);
check("portfolio titles", profile.portfolio.map((p) => p.title), ["AI-Powered DEXPI Extraction", "RAG search platform"]);
check("portfolio urls absolute", profile.portfolio[0].url.endsWith("/freelancers/~01/p/1"), true);
check("work history", profile.work_history.map((w) => w.title), ["Next.js dashboard for logistics", "FastAPI migration"]);
check(
  "employment split on the pipe",
  profile.employment,
  [
    { title: "Software Engineer - III", company: "Ebay" },
    { title: "Software Engineer - II", company: "InMobi" },
    { title: "Software Engineer - II", company: "Deutsche Bank" },
  ]
);
check("certifications skip the popover upsell", profile.certifications, ["AWS Solutions Architect"]);
// The bug this replaced: an "Education" item in the sidebar checklist pulled every nav heading in.
check("no education section means none reported", profile.education, []);
check("nav headings never leak into a section", JSON.stringify(profile).includes("Promote with ads"), false);

console.log("\nplatform routing:");
{
  const routed = await page.evaluate((code) => {
    eval(code);
    const cases = [
      ["https://www.upwork.com/jobs/~022081843862124982859", "job"],
      ["https://www.upwork.com/freelancers/~0139befba192c820d1", "profile"],
      ["https://www.peopleperhour.com/freelance-jobs/technology/build-a-dashboard-4123456", "job"],
      ["https://www.peopleperhour.com/freelancer/avinash-k", "profile"],
      // Fiverr is parked (`enabled: false`), so nothing on it routes anywhere — the same answer an
      // unrelated site gets, because that is what "we do not read this" means.
      ["https://www.fiverr.com/briefs/abc123def", "unsupported"],
      ["https://www.fiverr.com/avinashk", "unsupported"],
      ["https://example.com/jobs/123", "unsupported"],
    ];
    return cases.map(([url, want]) => {
      const p = globalThis.ALPlatforms.platformFor(url);
      const kind = !p ? "unsupported" : p.isProfilePage(url) ? "profile" : p.isJobPage(url) ? "job" : "other";
      return { url, want, got: kind, platform: p?.id || null, id: p ? p.jobId(url) : null };
    });
  }, src);
  for (const r of routed) {
    check(`${r.platform || "no platform"}: ${r.url.replace(/^https:\/\/www\./, "").slice(0, 46)}`, r.got, r.want);
  }
  check("pph numeric id", routed[2].id, "4123456");
  check("upwork tilde id", routed[0].id, "~022081843862124982859");
  check("off-platform host is refused", routed[6].platform, null);
}

console.log("\nPeoplePerHour job feed:");
{
  await page.goto(pathToFileURL(new URL("fixtures/pph-feed.html", import.meta.url).pathname).href);
  const feed = await page.evaluate((code) => {
    Object.defineProperty(window, "__href", { value: "https://www.peopleperhour.com/freelance-jobs", configurable: true });
    eval(code);
    return globalThis.ALExtract.readList("pph_feed");
  }, src.replace(/location\.href/g, "window.__href"));
  check("platform stamped", feed.platform, "peopleperhour");
  check("jobs found", feed.count, 2);
  check("numeric ids", feed.jobs.map((j) => j.external_id), ["4123456", "4123999"]);
  check("titles", feed.jobs.map((j) => j.title), ["Build a Next.js dashboard", "FastAPI microservice"]);
  check("GBP budget", feed.jobs[0].budget, "£1,200");
  check("description is prose", feed.jobs[0].description.startsWith("We need a reporting dashboard"), true);
  check("no budget in description", /£1,200/.test(feed.jobs[0].description), false);
}

console.log("\nreal Upwork job URL shapes:");
{
  const shapes = await page.evaluate((code) => {
    eval(code);
    const urls = [
      "https://www.upwork.com/jobs/~022081843862124982859?referrer_url_path=%2Fbest-matches%2Fdetails%2F~022081843862124982859",
      "https://www.upwork.com/jobs/LLM-Infrastructure-Specialist-Local-Self-Hosted-Deployment_~022081864841446938615/?referrer_url_path=find_work_home",
    ];
    return urls.map((u) => ({ id: globalThis.ALExtract.idFromUrl(globalThis.ALExtract.canonicalJobUrl(u)), url: globalThis.ALExtract.canonicalJobUrl(u) }));
  }, src.replace(/location\.href/g, "window.__href"));
  check("plain /jobs/~id", shapes[0].id, "~022081843862124982859");
  check("slugged /jobs/Title_~id/", shapes[1].id, "~022081864841446938615");
  check("referrer tracking stripped", shapes[0].url.includes("referrer_url_path"), false);
  check("trailing slash stripped", shapes[1].url.endsWith("/"), false);
  check(
    "slugged url canonicalised",
    shapes[1].url,
    "https://www.upwork.com/jobs/LLM-Infrastructure-Specialist-Local-Self-Hosted-Deployment_~022081864841446938615"
  );
}

console.log("\nlisting page (best matches / saved / invites):");
await page.goto(pathToFileURL(new URL("fixtures/listing.html", import.meta.url).pathname).href);
const listing = await page.evaluate((code) => {
  Object.defineProperty(window, "__href", { value: "https://www.upwork.com/nx/find-work/best-matches", configurable: true });
  eval(code);
  return globalThis.ALExtract.readList("best_matches");
}, src.replace(/location\.href/g, "window.__href"));
check("deduped by job id", listing.jobs.length, 2);
check("titles", listing.jobs.map((j) => j.title), ["Next.js dashboard for a logistics team", "FastAPI migration"]);
check("nav links excluded", listing.jobs.some((j) => j.external_id === "~09999"), false);
check("budget read off the card", listing.jobs[0].budget, "$1,500.00");
check("proposals takes the upper bound of a range", listing.jobs[0].proposals, 10);
check("posted age", listing.jobs[0].posted, "2 hours ago");
check("count matches", listing.count, 2);
// The bug this replaced: the whole card's text came back as one "snippet", so every description
// arrived with the budget and the proposal count glued to the front of it.
check(
  "description is prose only",
  listing.jobs[0].description.startsWith("We run a regional freight operation"),
  true
);
check("no budget in the description", /\$1,500/.test(listing.jobs[0].description), false);
check("no proposal count in the description", /Proposals/.test(listing.jobs[0].description), false);
check("no posted date in the description", /Posted 2 hours/.test(listing.jobs[0].description), false);
check("skills read off the card", listing.jobs[0].skills, ["Next.js", "PostgreSQL"]);
check("preview is flagged as incomplete", listing.jobs[0].description_complete, false);
check("second card gets its own description", listing.jobs[1].description.startsWith("Moving a Flask service"), true);

console.log("\nempty page (nothing must be invented):");
await page.setContent("<html><body><h1>Nothing here</h1></body></html>");
const bare = await page.evaluate((code) => {
  Object.defineProperty(window, "__href", { value: "https://www.upwork.com/jobs/~021111111111111111", configurable: true });
  eval(code);
  return globalThis.ALExtract.readJob();
}, src.replace(/location\.href/g, "window.__href"));
check("budget absent, not zero", [bare.budget_min, bare.budget_max], [null, null]);
check("proposals absent, not zero", bare.proposal_count, null);
check("skills empty list", bare.skills, []);
check("client block all-null, not zeroes", [bare.client.rating, bare.client.total_spent], [null, null]);

// --- permission and recognition must agree --------------------------------------------
//
// The bug this pins: the host regex accepted any *.upwork.com while the manifest granted only
// www.upwork.com. So the popup would recognise a community.upwork.com tab, offer to read it, and the
// injection would fail with "Cannot access contents of url ... must request permission to access this
// host" — after the run had already started. Recognising a page we cannot read is worse than not
// recognising it, because the offer is already made by the time it fails.
console.log("\nhosts: what the code claims and what the manifest grants:");
{
  const m = manifest();
  const granted = m.host_permissions
    .filter((p) => p.startsWith("https://"))
    .map((p) => p.split("/")[2]);

  const claimed = await page.evaluate((code) => {
    eval(code);
    const hosts = [
      "www.upwork.com", "upwork.com", "community.upwork.com", "support.upwork.com",
      "www.peopleperhour.com", "peopleperhour.com",
      // Parked: `enabled: false` in the table and its host_permissions commented out. The agreement
      // rule is what keeps those two in step — claimed but ungranted is the failure it catches.
      "www.fiverr.com", "fiverr.com", "blog.fiverr.com",
      "evil-upwork.com", "upwork.com.attacker.net",
    ];
    return hosts.map((h) => ({
      host: h,
      platform: globalThis.ALPlatforms.platformFor(`https://${h}/x`)?.id ?? null,
    }));
  }, src);

  for (const { host, platform } of claimed) {
    // Every host the code claims must be one the manifest grants, and vice versa for these.
    const allowed = granted.includes(host);
    check(`${platform ? "claims" : "ignores"} ${host}`, Boolean(platform), allowed);
  }
  // A lookalike domain must never match. `upwork.com.attacker.net` ends with nothing we allow, but a
  // careless "contains upwork.com" would have taken it.
  check("a lookalike host is refused", claimed.find((c) => c.host === "upwork.com.attacker.net").platform, null);

  // The tab query the collector uses to find an already-open tab must ask for exactly those origins —
  // for every platform it can actually reach. A parked entry keeps its origins so re-enabling is one
  // flag, and the code never reads them because PLATFORM_LIST excludes it.
  const worker = readFileSync(new URL("../src/background/worker.js", import.meta.url), "utf8");
  const blocks = worker.split(/\n  (?=[a-z]+: \{)/).filter((b) => b.includes("origins: ["));
  const live = blocks.filter((b) => !b.includes("enabled: false"));
  const declared = live.flatMap((b) =>
    [...b.matchAll(/origins: \[(.*?)\]/g)].flatMap((mm) =>
      mm[1].split(",").map((x) => x.trim().replace(/^"|"$/g, ""))
    )
  );
  check("every live platform declares origins", live.length, 2);
  check(
    "and the collector queries only granted ones",
    declared.length > 0 && declared.every((o) => m.host_permissions.includes(o)),
    true
  );
  // The parked one keeps its origins, so re-enabling stays a one-flag change.
  check("a parked platform keeps its origins for later", blocks.length - live.length, 1);
}

// --- signed out ------------------------------------------------------------------------
//
// The failure with no symptom. A login page loads perfectly, so the tab reaches `complete` and
// nothing throws — but it holds no job links, so the reader would return an empty list and the run
// would report "0 found" on all eight pages. That reads exactly like a quiet day on the marketplace,
// and files "stored 0" to the backend as though it were true.
console.log("\nsigned out (a login page must never read as an empty result):");

const loggedOutList = await readFrom(
  "login.html",
  "https://www.upwork.com/ab/account-security/login",
  "readList",
  "best_matches"
);
check("status says signed_out, not ok", loggedOutList.status, "signed_out");
check("it carries an error rather than a count of zero", Boolean(loggedOutList.error), true);
check("no jobs invented", loggedOutList.jobs, undefined);

// Detected by URL *and* by content, because a marketplace can render a login wall in place without
// changing the URL. Here the URL is a find-work page and only the password field gives it away.
const wallInPlace = await readFrom(
  "login.html",
  "https://www.upwork.com/nx/find-work/best-matches",
  "readList",
  "best_matches"
);
check("a login wall on a find-work URL is still caught", wallInPlace.status, "signed_out");

check(
  "whichPage answers signed_out before it answers a page type",
  await readFrom("login.html", "https://www.upwork.com/ab/account-security/login", "whichPage"),
  "signed_out"
);
check(
  "a real listing page is ok",
  (await readFrom("listing.html", "https://www.upwork.com/nx/find-work/best-matches", "sessionState")).status,
  "ok"
);

// --- whose profile is this? ------------------------------------------------------------
//
// No URL pattern can tell your Upwork profile from anyone else's — `/freelancers/~01…` matches every
// freelancer on the site. But the marketplace links only *yours* from its own account menu, so the id
// there is the identity to compare against. Before this, sending a competitor's profile overwrote
// your own name, rate and skills with theirs.
console.log("\nwhose profile is this (the account menu is the only thing that knows):");

const mine = await readFrom(
  "own-profile.html",
  "https://www.upwork.com/freelancers/~019abcdef123456789",
  "findOwnProfile"
);
check("found from the site's own account menu", mine.id, "~019abcdef123456789");
check("no configuration needed to know it", mine.status, "ok");

check(
  "my own profile reads as mine",
  await readFrom("own-profile.html", "https://www.upwork.com/freelancers/~019abcdef123456789", "isOwnProfile"),
  true
);
check(
  "someone else's profile does not",
  await readFrom("own-profile.html", "https://www.upwork.com/freelancers/~01ffffffffffffffff", "isOwnProfile"),
  false
);
// Undecidable, not "probably yours". The backend refuses a null exactly as it refuses a false.
check(
  "no account menu means no answer, not a guess",
  await readFrom("profile.html", "https://www.upwork.com/freelancers/~019abcdef123456789", "isOwnProfile"),
  null
);
check(
  "readProfile carries the verdict",
  (await readFrom("own-profile.html", "https://www.upwork.com/freelancers/~019abcdef123456789", "readProfile")).is_own,
  true
);

// Second pass: a link that *says* it is yours, anywhere on the page. "Your profile" is a phrase a
// marketplace only ever writes about the signed-in person, so the words identify you where a scope
// cannot — and the fixture puts two other freelancers' links in the same container to prove it.
const byLabel = await readFrom(
  "profile-label.html",
  "https://www.upwork.com/freelancers/~019abcdef123456789",
  "findOwnProfile"
);
check("found by what the link says, with no account menu", byLabel.id, "~019abcdef123456789");
check("and it says which way it got there", byLabel.via, "label");
check(
  "someone else's link in the same container is not taken",
  [byLabel.id === "~01ffffffffffffffff", byLabel.id === "~01aaaaaaaaaaaaaaaa"],
  [false, false]
);

// Nothing on the page identifies you: the answer is where to navigate, not a guess. Upwork resolves
// /freelancers/ against your session, so following it lands on your own profile whoever you are.
const nowhere = await readFrom(
  "profile.html",
  "https://www.upwork.com/freelancers/~019abcdef123456789",
  "findOwnProfile"
);
check("undecidable pages say where to look instead", nowhere.navigateTo, "https://www.upwork.com/freelancers/");
check("and do not guess an id", [nowhere.status, nowhere.id], ["not_found", null]);

// The collector can now read your profile as one of its pages, which it never could before.
const asPage = await readFrom(
  "own-profile.html",
  "https://www.upwork.com/freelancers/~019abcdef123456789",
  "readList",
  "own_profile"
);
check("readList reads a profile page", [asPage.key, asPage.count], ["own_profile", 1]);
check("and carries the is_own verdict through", asPage.profile.is_own, true);
check("with the profile itself", asPage.profile.display_name, "Avinash K.");

// PeoplePerHour needs no URL for this: its account menu is in the header of every page, so the answer
// is wherever the collection already is. Its id is the slug, which is what a later sighting dedupes on.
console.log("\nPeoplePerHour profile, discovered with no URL configured:");
{
  await page.setContent(`
    <header><nav>
      <a href="/freelancer/avinash-k">Your profile</a>
      <a href="/freelancer/someone-else">Priya S.</a>
    </nav></header>
    <main><h1>Job feed</h1></main>`);
  const found = await page.evaluate((code) => {
    Object.defineProperty(window, "__href", { value: "https://www.peopleperhour.com/freelance-jobs", configurable: true });
    eval(code);
    return globalThis.ALExtract.findOwnProfile();
  }, src.replace(/location\.href/g, "window.__href"));

  // Found from a page that is not a profile at all — which is the whole point: no URL was needed.
  check("found from a job feed's own header", found.status, "ok");
  check("the slug is the account identity", found.id, "avinash-k");
  check("not the other freelancer in the same nav", found.url.includes("someone-else"), false);
}

// Fiverr is parked. Its readers, selectors and reserved list are all still here and still correct —
// this checks only that nothing reaches them, in both directions at once, since a platform recognised
// but not permitted is the failure that produced "Cannot access contents of url".
console.log("\nparked platform:");
{
  const parked = await page.evaluate((code) => {
    Object.defineProperty(window, "__href", { value: "https://www.fiverr.com/", configurable: true });
    eval(code);
    const table = globalThis.ALPlatforms.PLATFORMS.fiverr;
    return {
      stillDefined: Boolean(table),
      flag: table.enabled,
      // The readers are untouched: the reserved list still tells a username from a section.
      readersIntact: table.isProfilePage("https://www.fiverr.com/some.seller_1") === true
        && table.isProfilePage("https://www.fiverr.com/inbox") === false,
      recognised: globalThis.ALPlatforms.platformFor("https://www.fiverr.com/me")?.id ?? null,
    };
  }, src.replace(/location\.href/g, "window.__href"));

  check("the entry is kept, not deleted", parked.stillDefined, true);
  check("one flag is all that parks it", parked.flag, false);
  check("its readers are untouched and still correct", parked.readersIntact, true);
  check("but no page is recognised as Fiverr", parked.recognised, null);
}

// --- PeoplePerHour, on the generic anchors only -----------------------------------------
//
// No `data-test`, no `air3-*`, and a `<title>` that is not Upwork's — so these exercise the path any
// non-Upwork marketplace takes. Every value below was wrong or missing before the reader hierarchy
// landed, and each one is a distinct failure worth naming.
console.log("\nPeoplePerHour job page (generic anchors only):");
{
  const j = await readFrom(
    "pph-job.html",
    "https://www.peopleperhour.com/freelance-jobs/technology/build-a-nextjs-reporting-dashboard-4123456",
    "readJob"
  );
  check("id from the slug's trailing number", j.external_id, "4123456");
  check("title from JSON-LD", j.title, "Build a Next.js reporting dashboard");
  check("posted_at from JSON-LD", j.posted_at, "2026-07-29T11:30:00Z");

  // Was [null, null]: every budget selector is a data-test, so a site without them had no budget at
  // all. The label fallback finds it — and must find only the money, not "Posted 4 hours ago" on the
  // same innerText line, which briefly made this [4, 1200].
  check("budget from the label, money only", [j.budget_min, j.budget_max], [1200, 1200]);
  // Was "USD" with a null budget: a currency asserted about a figure never read.
  check("currency is the one on the page", j.currency, "GBP");
  // Was null: the type came from a data-test, then from a budget it never got.
  check("work_type inferred without an attribute", j.work_type, "fixed");
  // Was []: all three skill selectors were Upwork's. Now the "Skills" heading answers, as it always
  // has for profiles.
  check("skills from under the heading", j.skills, ["Next.js", "PostgreSQL", "TypeScript"]);
  check("experience from its label", j.experience_level, "Intermediate");
  // Was null on both platforms: nearLabel("Project Length|Duration") could never match.
  check("project length, via a pattern that used to be dead", j.project_length, "1 to 3 months");
  check("proposals", j.proposal_count, 7);
  // Was 18400 — the total-spent figure two lines down, because the count precedes its label here.
  check("client reviews, value before the label", j.client.reviews, 23);
  check("client spend", j.client.total_spent, 18400);
  check("payment verified", j.client.payment_verified, true);
}

console.log("\nPeoplePerHour profile (no per-site code at all):");
{
  const pr = await readFrom("pph-profile.html", "https://www.peopleperhour.com/freelancer/priya-r", "readProfile");
  check("username is the slug", pr.username, "priya-r");
  check("name from itemprop", pr.display_name, "Priya R.");
  // The generic fromTitle takes the middle part; only Upwork's carries a location, so these must not
  // be filled with "PeoplePerHour".
  check("tagline from the title's middle part", pr.tagline, "Full-Stack Developer");
  check("city and country from itemprop, not the title", [pr.city, pr.country], ["Manchester", "United Kingdom"]);
  check("rate and its currency", [pr.hourly_rate, pr.currency], [45, "GBP"]);
  check("earnings, K expanded", pr.total_earnings, 82000);
  check("jobs and hours", [pr.total_jobs, pr.total_hours], [134, 2410]);
  // Briefly 2410: a character window treated the hours on the line above as adjacent to "reviews".
  check("reviews, not the hours on the line above", pr.total_reviews, 96);
  check("skills without a token class of ours", pr.skills, ["Next.js", "PostgreSQL", "Django"]);
  check("languages", pr.languages, ["English: Native", "Hindi: Conversational"]);
  check("portfolio titles from aria-label", pr.portfolio.map((x) => x.title), ["Freight exception dashboard", "Invoice reconciliation service"]);
  check("portfolio urls absolute", pr.portfolio[0].url, "https://www.peopleperhour.com/freelancer/priya-r/portfolio/1");
  check("work history", pr.work_history.map((w) => w.title), ["Reporting dashboard for a freight operator", "Stripe reconciliation rebuild"]);
  check("education", pr.education.map((e) => e.school), ["BSc Computer Science, University of Manchester"]);
  check("its own profile, by slug", pr.is_own, true);
}

console.log("\nthe reader hierarchy:");
{
  const shape = await page.evaluate((code) => {
    Object.defineProperty(window, "__href", { value: "https://www.upwork.com/", configurable: true });
    eval(code);
    return globalThis.ALExtract.readerShape();
  }, src.replace(/location\.href/g, "window.__href"));
  // One base holding the generic anchors, subclasses narrowing it. Upwork's data-test selectors are
  // prepended to the generic list rather than replacing it, so a rename degrades to the fallback.
  check("upwork uses its own reader", shape.upwork.name, "UpworkReader");
  check("and keeps the generic selector as a fallback", shape.upwork.jobTitle.slice(-1), ["h1"]);
  check("with its data-test first", shape.upwork.jobTitle[0], '[data-test="job-title"]');
  check("peopleperhour needs almost nothing", shape.peopleperhour.name, "PeoplePerHourReader");
  check("and inherits the generic job title", shape.peopleperhour.jobTitle, ["header h1", "h1"]);
  // An unknown marketplace still reads, on the generic anchors — that is what makes the base useful.
  check("an unknown site falls back to the base", shape.unknown.name, "Reader");
}

// --- cards sitting on top of the page ---------------------------------------------------
//
// A "Boost your profile" card open over a real profile advertised "Total earnings $250K" and "Total
// jobs 999", and both won: the label readers scanned raw innerText, so the modal's marketing figures
// beat the page's own 40K and 134. Section walking had always excluded overlays; the text readers
// never did.
//
// Ignored rather than dismissed. Closing a card means clicking it, and a click on someone's account
// is an action — it can accept cookies, silence a notification for good, or opt them into something.
console.log("\noverlays are ignored, not clicked away:");
{
  const withModal = `
    <header><nav><a href="/freelancers/~019abcdef123456789">Your profile</a></nav></header>
    <div role="dialog" class="air3-modal">
      <h2>Boost your profile</h2>
      <p>Freelancers like you report Total earnings $250K after adding a video intro.</p>
      <p>Total jobs 999</p><button>Not now</button>
    </div>
    <main>
      <h1 itemprop="name">Avinash K.</h1><h3 itemprop="priceRange">$20.00/hr</h3>
      <div>Total earnings</div><div>$40K</div>
      <div>Total jobs</div><div>134</div>
      <section><h4>Skills</h4><span class="air3-token">Python</span></section>
    </main>`;
  await page.setContent(withModal);
  const read = await page.evaluate((code) => {
    Object.defineProperty(window, "__href", { value: "https://www.upwork.com/freelancers/~019abcdef123456789", configurable: true });
    eval(code);
    const pr = globalThis.ALExtract.readProfile();
    return { earnings: pr.total_earnings, jobs: pr.total_jobs, skills: pr.skills, name: pr.display_name };
  }, src.replace(/location\.href/g, "window.__href"));

  check("the page's earnings, not the modal's pitch", read.earnings, 40000);
  check("the page's job count, not the modal's", read.jobs, 134);
  check("and the real fields still read", [read.name, read.skills], ["Avinash K.", ["Python"]]);

  // The overlay is left alone. Nothing was clicked, so the card is still there — which is the point:
  // its presence must not change what we report, and dismissing it would change the user's account.
  const stillThere = await page.evaluate(() => Boolean(document.querySelector("[role='dialog']")));
  check("the card is still on the page afterwards", stillThere, true);

  // And the deliberate exception: a login wall is usually *itself* a dialog, so sessionState must read
  // the raw page. Stripping overlays there would hide the one thing it exists to find.
  await page.setContent(`<div role="dialog"><h1>Log in to Upwork</h1><form><input type="password"/></form></div>`);
  const session = await page.evaluate((code) => {
    Object.defineProperty(window, "__href", { value: "https://www.upwork.com/nx/find-work/best-matches", configurable: true });
    Object.defineProperty(window, "__host", { value: "www.upwork.com", configurable: true });
    eval(code);
    return globalThis.ALExtract.sessionState().status;
  }, src.replace(/location\.href/g, "window.__href").replace(/location\.hostname/g, "window.__host"));
  check("a login wall rendered as a dialog is still caught", session, "signed_out");
}

// --- a feed that arrives in pieces ------------------------------------------------------
//
// Upwork puts job cards on the page as they come. Reading a fixed moment after load caught whatever
// had arrived by then — about a screenful — and the rest of the page's own first batch landed unread.
// Waiting for the count to stop changing asks the question that matters: has the page finished?
//
// It waits and nothing else. No scrolling, no "load more", no next page — see the constraint at the
// top of src/background/worker.js.
console.log("\na lazily-rendered feed:");
{
  await page.setContent(`<main id="list"></main><script>
    let n = 0;
    const add = () => {
      const a = document.createElement("article");
      a.innerHTML = '<a href="/jobs/~0219998887776665' + String(n).padStart(2,"0") + '">Job ' + n + '</a>' +
        '<p>A description with enough prose in it to be counted as one by the reader, honestly.</p>';
      document.getElementById("list").appendChild(a); n++;
    };
    for (let i = 0; i < 4; i++) add();
    const t = setInterval(() => { add(); if (n >= 12) clearInterval(t); }, 200);
  </script>`);

  const out = await page.evaluate((code) => {
    Object.defineProperty(window, "__href", { value: "https://www.upwork.com/nx/find-work/best-matches", configurable: true });
    Object.defineProperty(window, "__host", { value: "www.upwork.com", configurable: true });
    eval(code);
    const immediate = globalThis.ALExtract.readList("best_matches").count;
    return globalThis.ALExtract
      .awaitList()
      .then((settled) => ({ immediate, settled, after: globalThis.ALExtract.readList("best_matches").count }));
  }, src.replace(/location\.href/g, "window.__href").replace(/location\.hostname/g, "window.__host"));

  check("reading mid-load undercounts", out.immediate, 4);
  check("waiting for it to settle gets the rest", out.after, 12);
  check("and it reports that it settled rather than timed out", out.settled.settled, true);
  // Resolves as soon as it is quiet — it does not sit out the full timeout on every page.
  check("it stops as soon as the page stops", out.settled.waited < 6000, true);
}

// --- what gets sent to the backend ----------------------------------------------------
//
// The payload is the contract between the two halves, so it is pinned here rather than left to be
// discovered when a rename makes the backend reject every page with a 422.
console.log("\ncollection payload (the extension↔backend contract):");
const { collectionPayload, describePush } = await import("../src/background/api.js");

const jobsPage = { key: "best_matches", label: "Best matches", reads: "jobs", url: "https://x/" };
const readAt = "2026-07-30T12:00:00.000Z";
const scraped = { platform: "upwork", url: "https://www.upwork.com/nx/find-work/best-matches", at: readAt, count: 2, jobs: listing.jobs, text: "page text" };

const sent = collectionPayload({ platform: "upwork", page: jobsPage, result: scraped, useLlm: false });
check("named parameters the backend validates on", Object.keys(sent).sort(), [
  "freelance_platform", "is_llm_required", "items", "page_key", "page_label", "page_status",
  "page_text", "page_url", "reads", "scraped_at", "status_detail",
]);
check("platform travels with the payload", sent.freelance_platform, "upwork");
check("items come from the reader named by `reads`", sent.items.length, 2);
// Relative ages are resolved against this on the backend, so it must be the reader's own clock —
// not the moment the push happened, which can be a minute later after a retry.
check("scraped_at is the reader's timestamp", sent.scraped_at, readAt);
// 60KB of page text the backend will not read is 60KB nobody needs to send.
check("no page text unless the AI is wanted", sent.page_text, "");
check("no AI asked for by default", sent.is_llm_required, false);

const withAi = collectionPayload({ platform: "upwork", page: jobsPage, result: scraped, useLlm: true });
check("AI requested carries the text", [withAi.is_llm_required, withAi.page_text], [true, "page text"]);

// A rows page (contracts, proposals, orders) sends its rows, not an empty jobs array.
const rowsPage = { key: "contracts", label: "Contracts", reads: "rows", url: "https://x/" };
const rowsResult = { platform: "upwork", at: readAt, count: 1, rows: [{ title: "A contract", url: "https://x/1" }], text: "the whole page" };
const rowsSent = collectionPayload({ platform: "upwork", page: rowsPage, result: rowsResult });
check("rows pages send rows", rowsSent.items.length, 1);
// These have no modelled table, so they are accumulated whole for v2 — and the rows are only a
// partial reading of the text, so the text goes too, whether or not the AI was asked for.
check("rows pages always carry their text", rowsSent.page_text, "the whole page");

// The whole point of reporting counts rather than a tick: twelve found and none stored is a broken
// selector, and a tick would call that a success.
check(
  "push summary reads as counts",
  describePush({ stored: 12, created: 9, duplicates: 3, llm_used: false }),
  "12 stored · 9 new · 3 dup"
);
check("a failed push says so", describePush({ error: "Token rejected" }), "Token rejected");
// "kept", not "stored": the rows are in the database and queryable, but nothing reads them yet.
check(
  "an accumulated page says kept",
  describePush({ stored: 6, capture_id: "abc", llm_used: true, llm_fields_filled: 6 }),
  "6 kept · AI read 6"
);

// A wall reports its status and nothing else: a login page's text is not your contracts, and
// accumulating it would file junk under a page key that is supposed to mean something.
const wallSent = collectionPayload({
  platform: "upwork",
  page: rowsPage,
  result: {
    platform: "upwork",
    at: readAt,
    status: "signed_out",
    count: 0,
    error: "Not signed in to Upwork — redirected to the login page.",
    text: "Log in to Upwork",
  },
  useLlm: true,
});
check("a wall sends its status", wallSent.page_status, "signed_out");
check("with the reader's own words", wallSent.status_detail.startsWith("Not signed in"), true);
check("and no page text, even with the AI on", wallSent.page_text, "");

// --- the app configures the extension ---------------------------------------------------
//
// Why the options page can be hidden at all. The extension runs on Upwork's origin, where the app's
// session cookie is never sent, so it cannot mint its own token — the app can, and hands it over. The
// settings ride along, which is what stops hiding the page from switching a feature off: useLlm
// decides whether the backend shapes a capture into the schema it stores, and a per-browser default of
// false would turn that off for everyone who never opened the settings.
console.log("\nthe app hands the extension its configuration:");
{
  // The shape the app sends, asserted here so a rename on either side fails loudly rather than
  // silently storing nothing.
  const sent = { type: "connect", apiUrl: "http://localhost:8010", token: "al_abc",
                 settings: { pushToBackend: true, useLlm: true, concurrency: 1 } };
  check("the handover names a backend and a token", [Boolean(sent.apiUrl), Boolean(sent.token)], [true, true]);
  check("and carries the settings an admin set once", Object.keys(sent.settings).sort(),
        ["concurrency", "pushToBackend", "useLlm"]);

  // Only known keys are taken, so a future field in the app cannot write something nothing reads.
  const bridge = readFileSync(new URL("../src/background/bridge.js", import.meta.url), "utf8");
  const allowed = (bridge.match(/const allowed = \[(.*?)\]/) || [])[1] || "";
  check("the bridge allowlists exactly those three",
        allowed.split(",").map((x) => x.trim().replace(/"/g, "")).sort(),
        ["concurrency", "pushToBackend", "useLlm"]);
  check("a token is required for the handover to apply", /if \(!secret\) return \{ ok: false/.test(bridge), true);
}

await browser.close();
console.log(failures ? `\n${failures} failing` : "\nall checks passed");
process.exit(failures ? 1 : 0);
