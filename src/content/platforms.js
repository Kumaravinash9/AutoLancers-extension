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

const PLATFORMS = {
  upwork: {
    id: "upwork",
    label: "Upwork",
    host: /(^|\.)upwork\.com$/,

    // `~021…` appears in both link shapes Upwork uses: bare, and slug-then-id.
    jobId: (url) => (url.match(/~[0-9a-zA-Z]{10,}/) || [null])[0],
    jobLink: 'a[href*="/jobs/~"], a[href*="/jobs/"]',
    isJobPage: (url) => /upwork\.com\/(?:nx\/)?jobs?\/[^/]*~[0-9a-zA-Z]{10,}/.test(url),
    isProfilePage: (url) => /upwork\.com\/freelancers\/~[0-9a-zA-Z]{10,}/.test(url),
    profileExample: "upwork.com/freelancers/~0abc…",
    jobExample: "upwork.com/jobs/~021abc…",

    pages: [
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
    host: /(^|\.)peopleperhour\.com$/,

    // PPH uses a numeric id at the end of a slug: /freelance-jobs/…-4123456
    jobId: (url) => (url.match(/-(\d{5,})(?:\/|$|\?)/) || [null, null])[1],
    jobLink: 'a[href*="/freelance-jobs/"], a[href*="/job/"]',
    isJobPage: (url) => /peopleperhour\.com\/(?:freelance-jobs|job)\/[^?]*\d{5,}/.test(url),
    isProfilePage: (url) => /peopleperhour\.com\/freelancer\//.test(url),
    profileExample: "peopleperhour.com/freelancer/…",
    jobExample: "peopleperhour.com/freelance-jobs/…-4123456",

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
    host: /(^|\.)fiverr\.com$/,

    // Fiverr is a listing marketplace, not a bidding one: sellers publish gigs and buyers come to
    // them. Buyer Requests — the closest thing it had to a job board — were removed in 2023. So
    // there is no job feed to score here, and what is worth collecting is your own side of it:
    // your gigs, your orders, your seller profile.
    jobId: (url) => (url.match(/\/(?:gigs?|briefs?)\/([A-Za-z0-9_-]{6,})/) || [null, null])[1],
    jobLink: 'a[href*="/gigs/"], a[href*="/briefs/"]',
    isJobPage: (url) => /fiverr\.com\/(?:gigs?|briefs?)\//.test(url),
    isProfilePage: (url) => /fiverr\.com\/(?!gigs?\/|briefs?\/|categories\/)[A-Za-z0-9_.-]+\/?$/.test(url),
    profileExample: "fiverr.com/your-username",
    jobExample: "fiverr.com/briefs/…",

    pages: [
      { key: "fvr_gigs", label: "My gigs", link: "/users", url: "https://www.fiverr.com/users/_/manage_gigs", reads: "rows" },
      { key: "fvr_orders", label: "Orders", link: "/orders", url: "https://www.fiverr.com/orders", reads: "rows" },
      { key: "fvr_briefs", label: "Briefs", link: "/briefs", url: "https://www.fiverr.com/briefs", reads: "jobs" },
      { key: "fvr_inbox", label: "Inbox", link: "/inbox", url: "https://www.fiverr.com/inbox", reads: "rooms" },
    ],
  },
};

/** The platform for a URL, or null when we are somewhere we do not read. */
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
