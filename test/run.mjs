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
    return name === "readJob" ? readJob() : readProfile();
  }, [src.replace(/location\.href/g, "window.__href"), fn, fixture === "job.html"
      ? "https://www.upwork.com/jobs/~021999888777666555"
      : "https://www.upwork.com/freelancers/~019abcdef123456789"]);
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
      ["https://www.fiverr.com/briefs/abc123def", "job"],
      ["https://www.fiverr.com/avinashk", "profile"],
      ["https://example.com/jobs/123", "unsupported"],
    ];
    return cases.map(([url, want]) => {
      const p = platformFor(url);
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
    return readList("pph_feed");
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
    return urls.map((u) => ({ id: idFromUrl(canonicalJobUrl(u)), url: canonicalJobUrl(u) }));
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
  return readList("best_matches");
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
  return readJob();
}, src.replace(/location\.href/g, "window.__href"));
check("budget absent, not zero", [bare.budget_min, bare.budget_max], [null, null]);
check("proposals absent, not zero", bare.proposal_count, null);
check("skills empty list", bare.skills, []);
check("client block all-null, not zeroes", [bare.client.rating, bare.client.total_spent], [null, null]);

await browser.close();
console.log(failures ? `\n${failures} failing` : "\nall checks passed");
process.exit(failures ? 1 : 0);
