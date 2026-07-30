/**
 * What differs between marketplaces.
 *
 * The readers themselves turned out to be largely portable: anchoring on headings, `itemprop` and
 * link shapes works anywhere, and it is what survived Upwork's markup not matching a single one of
 * the `data-test` names we first guessed. What genuinely differs per site is small — the host, how
 * a job id is written into a URL, and which pages are worth collecting — so that is all this holds.
 *
 * Adding a marketplace should mean adding an entry here, not another copy of the readers.
 */

/**
 * Injected more than once per page, so it must be idempotent.
 *
 * `chrome.scripting.executeScript({files})` evaluates a classic script: a top-level `const` is a
 * redeclaration the second time, and a redeclaration is a SyntaxError that kills the entire file.
 * Every click after the first then failed with "Identifier already declared" while the first
 * appeared to work. Guarding on the namespace makes re-injection a no-op.
 */
globalThis.ALPlatforms ||= (() => {

/**
 * Fiverr's own top-level paths, which are shaped exactly like a username.
 *
 * `fiverr.com/inbox` and `fiverr.com/my-username` are indistinguishable by pattern, so telling them
 * apart takes a list. Erring towards "not a profile" is the safe direction: a profile page missed is
 * a button that doesn't appear, while a settings page mistaken for a profile is a scrape of the wrong
 * thing written into your profile row.
 */
const FIVERR_RESERVED = new Set([
  "inbox", "orders", "briefs", "gigs", "gig", "categories", "settings", "users", "start_selling",
  "login", "join", "signin", "logout", "dashboard", "notifications", "search", "support", "help",
  "cp", "seller_dashboard", "selling", "buying", "invoices", "earnings", "analytics", "pro",
  "business", "studios", "logo-maker", "share", "terms_of_service", "privacy_policy", "about",
]);

const PLATFORMS = {
  upwork: {
    id: "upwork",
    label: "Upwork",
    host: /^(?:www\.)?upwork\.com$/,

    // `~021…` appears in both link shapes Upwork uses: bare, and slug-then-id.
    jobId: (url) => (url.match(/~[0-9a-zA-Z]{10,}/) || [null])[0],
    jobLink: 'a[href*="/jobs/~"], a[href*="/jobs/"]',
    isJobPage: (url) => /upwork\.com\/(?:nx\/)?jobs?\/[^/]*~[0-9a-zA-Z]{10,}/.test(url),
    isProfilePage: (url) => /upwork\.com\/freelancers\/~[0-9a-zA-Z]{10,}/.test(url),
    profileExample: "upwork.com/freelancers/~0abc…",
    jobExample: "upwork.com/jobs/~021abc…",

    // Where a signed-out request lands. Upwork redirects any find-work URL here, so the reader must
    // recognise it: without this a logged-out run reports "0 jobs found" on every page, which is
    // indistinguishable from a quiet day on the marketplace.
    isLoginPage: (url) =>
      /upwork\.com\/(?:ab\/account-security\/login|nx\/signup|ab\/account-security\/sso)/.test(url),
    // Your own profile is whatever the site's own header links to. Only you get that link, so
    // following it is how "my profile" is answered without asking you to paste a URL.
    ownProfileLink: 'a[href*="/freelancers/~"]',
    // The id in the URL is the account identity; two profiles are the same person iff these match.
    profileId: (url) => (url.match(/~[0-9a-zA-Z]{10,}/) || [null])[0],

    // `/freelancers/` with no id: Upwork resolves it against your session and redirects to your own
    // profile. Worth having as a fallback because it depends on nothing about the page's markup —
    // where the header link is one redesign away from moving — and because it works from anywhere,
    // including a page with no account menu on it at all. It costs a navigation, which is why it is
    // the fallback rather than the first thing tried.
    ownProfileUrl: "https://www.upwork.com/freelancers/",

    pages: [
      { key: "own_profile", label: "My profile", link: "/freelancers/", url: "https://www.upwork.com/freelancers/", reads: "profile" },
      { key: "best_matches", label: "Best matches", link: "/nx/find-work/best-matches", url: "https://www.upwork.com/nx/find-work/best-matches", reads: "jobs" },
      { key: "most_recent", label: "Most recent", link: "/nx/find-work/most-recent", url: "https://www.upwork.com/nx/find-work/most-recent", reads: "jobs" },
      { key: "saved_jobs", label: "Saved jobs", link: "/nx/search/jobs/saved", url: "https://www.upwork.com/nx/search/jobs/saved/", reads: "jobs" },
      { key: "invites", label: "Invites", link: "/nx/find-work/invites", url: "https://www.upwork.com/nx/find-work/invites", reads: "jobs" },
      { key: "home", label: "Home", link: "/nx/wm/freelancer/home", url: "https://www.upwork.com/nx/wm/freelancer/home", reads: "jobs" },
      { key: "contracts", label: "Contracts", link: "/nx/wm/freelancer/contracts", url: "https://www.upwork.com/nx/wm/freelancer/contracts", reads: "rows" },
      { key: "reports", label: "Reports (in progress)", link: "/nx/reports/overview", url: "https://www.upwork.com/nx/reports/overview/?tab=in-progress", reads: "rows" },
      { key: "messages", label: "Message rooms", link: "/ab/messages", url: "https://www.upwork.com/ab/messages/rooms/", reads: "rooms" },
    ],
  },

  peopleperhour: {
    id: "peopleperhour",
    label: "PeoplePerHour",
    host: /^(?:www\.)?peopleperhour\.com$/,

    // PPH uses a numeric id at the end of a slug: /freelance-jobs/…-4123456
    jobId: (url) => (url.match(/-(\d{5,})(?:\/|$|\?)/) || [null, null])[1],
    jobLink: 'a[href*="/freelance-jobs/"], a[href*="/job/"]',
    isJobPage: (url) => /peopleperhour\.com\/(?:freelance-jobs|job)\/[^?]*\d{5,}/.test(url),
    isProfilePage: (url) => /peopleperhour\.com\/freelancer\//.test(url),
    profileExample: "peopleperhour.com/freelancer/…",
    jobExample: "peopleperhour.com/freelance-jobs/…-4123456",

    isLoginPage: (url) => /peopleperhour\.com\/(?:session\/new|login|signin|register)/.test(url),
    ownProfileLink: 'a[href*="/freelancer/"]',
    profileId: (url) => (url.match(/\/freelancer\/([^/?#]+)/) || [null, null])[1],

    pages: [
      { key: "pph_feed", label: "Job feed", link: "/freelance-jobs", url: "https://www.peopleperhour.com/freelance-jobs", reads: "jobs" },
      { key: "pph_saved", label: "Saved jobs", link: "/site/saved-jobs", url: "https://www.peopleperhour.com/site/saved-jobs", reads: "jobs" },
      { key: "pph_proposals", label: "My proposals", link: "/site/proposals", url: "https://www.peopleperhour.com/site/proposals", reads: "rows" },
      { key: "pph_orders", label: "Orders", link: "/site/orders", url: "https://www.peopleperhour.com/site/orders", reads: "rows" },
    ],
  },

  fiverr: {
    id: "fiverr",
    label: "Fiverr",
    host: /^(?:www\.)?fiverr\.com$/,

    // Fiverr is a listing marketplace, not a bidding one: sellers publish gigs and buyers come to
    // them. Buyer Requests — the closest thing it had to a job board — were removed in 2023. So
    // there is no job feed to score here, and what is worth collecting is your own side of it:
    // your gigs, your orders, your seller profile.
    jobId: (url) => (url.match(/\/(?:gigs?|briefs?)\/([A-Za-z0-9_-]{6,})/) || [null, null])[1],
    jobLink: 'a[href*="/gigs/"], a[href*="/briefs/"]',
    isJobPage: (url) => /fiverr\.com\/(?:gigs?|briefs?)\//.test(url),

    /**
     * A Fiverr seller profile is `fiverr.com/<username>` — the same shape as most of the site's own
     * pages, which is why this needs a reserved list rather than a lookahead for three of them.
     *
     * The earlier pattern excluded only gigs, briefs and categories, so `/inbox`, `/orders`,
     * `/settings` and `/users` all read as "a profile". That mattered: a page misread as a profile
     * gets scraped as one and then written into *your* profile row.
     */
    isProfilePage: (url) => {
      const match = url.match(/^https?:\/\/(?:www\.)?fiverr\.com\/([A-Za-z0-9_.-]+)\/?(?:[?#]|$)/);
      return Boolean(match) && !FIVERR_RESERVED.has(match[1].toLowerCase());
    },
    profileExample: "fiverr.com/your-username",
    jobExample: "fiverr.com/briefs/…",

    isLoginPage: (url) => /fiverr\.com\/(?:login|join|signin)/.test(url),
    // Fiverr's header links your own profile as `/<username>`; `/users/<username>/…` also carries it.
    ownProfileLink: 'a[href*="/users/"], header a[href^="/"]',
    profileId: (url) =>
      (url.match(/fiverr\.com\/(?:users\/)?([A-Za-z0-9_.-]+)/) || [null, null])[1],

    pages: [
      { key: "fvr_gigs", label: "My gigs", link: "/users", url: "https://www.fiverr.com/users/_/manage_gigs", reads: "rows" },
      { key: "fvr_orders", label: "Orders", link: "/orders", url: "https://www.fiverr.com/orders", reads: "rows" },
      { key: "fvr_briefs", label: "Briefs", link: "/briefs", url: "https://www.fiverr.com/briefs", reads: "jobs" },
      { key: "fvr_inbox", label: "Inbox", link: "/inbox", url: "https://www.fiverr.com/inbox", reads: "rooms" },
    ],
  },
};

/**
 * The platform for a URL, or null when we are somewhere we do not read.
 *
 * Matched on the exact host, not on "ends with upwork.com". Two reasons, and they agree:
 * `community.upwork.com` is a forum full of other people's posts rather than the job board, so
 * claiming it would be wrong on the merits — and the manifest grants no access to it either, so the
 * readers would fail with "Cannot access contents of url" after the popup had already offered.
 */
function platformFor(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return Object.values(PLATFORMS).find((p) => p.host.test(host)) || null;
}

/** The platform this page belongs to. */
function currentPlatform() {
  return platformFor(location.href);
}

  return { PLATFORMS, platformFor, currentPlatform };
})();
