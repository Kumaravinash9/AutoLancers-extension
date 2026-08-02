/**
 * The generic reader — everything a page might be asked for, anchored on nothing site-specific.
 *
 * Split into its own file because each marketplace's DOM is its own problem and deserves its own
 * place to be solved. What lives *here* is the opposite: the part that turned out not to differ.
 * PeoplePerHour profiles read completely with no per-site code at all, and every difficult bug in
 * this codebase has been in shared logic — walking a heading's section without swallowing the
 * sidebar, telling prose from a label, canonicalising two URL shapes into one id. Three copies of
 * that would mean fixing each of those three times.
 *
 * So a subclass exists for one of two reasons and no others:
 *
 *   1. It knows a **better selector** for a field the base can only guess at. Upwork's `data-test`
 *      attributes are the whole of that — prepended to the generic list, never replacing it, so a
 *      rename degrades to the fallback instead of to nothing.
 *   2. It needs a **different algorithm**. Upwork's `<title>` carries the tagline and location in a
 *      shape no other site uses, so `fromTitle` is overridden rather than parameterised. If a
 *      marketplace ships its jobs as JSON in a script tag, `readJobCards` is what it should replace:
 *      DOM-walking is the wrong approach for that page and no selector tuning fixes it.
 *
 * A class rather than a table of selectors because of reason 2 — a table cannot override an
 * algorithm.
 *
 * ## How these files find each other
 *
 * `executeScript({files})` evaluates classic scripts in order, each with its own top-level scope, so
 * a subclass in another file cannot see a class declared inside a closure here. The registry below is
 * what bridges that: this file publishes `Reader` and a `register` function on `globalThis`, and each
 * platform file registers itself against its own id. Adding a marketplace is a file plus a line in
 * the injection list, and nothing else changes.
 *
 * Injected *after* `extract.js`, which publishes the handful of shared helpers this needs — a class
 * with three dependencies is not worth duplicating a thousand lines of utilities for.
 */
globalThis.ALReaders ||= (() => {
  const { clean, structuredData, visibleText, absolute } = globalThis.ALExtractKit;

  class Reader {
    constructor(platform) {
      this.platform = platform;
      this._ld = null;
      this._text = null;
    }

    /** JSON-LD, parsed once per read rather than on every field that wants it. */
    get structured() {
      return (this._ld ??= structuredData());
    }

    /**
     * The page's text without its overlays, computed once per read.
     *
     * Once, because stripping means cloning the body and a profile makes twenty-five label reads — a
     * clone each would be twenty-five copies of the whole document.
     */
    get text() {
      return (this._text ??= visibleText());
    }

    /**
     * Selector lists, tried in order. A subclass prepends its own and keeps these as the fallback.
     *
     * Generic on purpose: `itemprop` is machine-readable and survives redesigns, and a heading is what
     * a human reads. Neither is any one marketplace's private convention.
     */
    get selectors() {
      return {
        jobTitle: ["header h1", "h1"],
        jobDescription: ["section[aria-labelledby*='description']", "[itemprop='description']"],
        jobBudget: [],
        jobType: [],
        jobSkills: [],
        jobCategory: [],
        jobProposals: [],
        clientCountry: [],
        clientCity: [],
        clientRating: [],
        clientSpend: [],
        clientMemberSince: [],
        clientIndustry: [],
        profileRate: ["[itemprop='priceRange']"],
        profileSummary: ["[itemprop='description']"],
        profileName: ["[itemprop='name']"],
        profileCountry: ["[itemprop='country-name']"],
        profileCity: ["[itemprop='locality']"],
        // Both marketplaces mark a skill chip with *some* class containing "token" or "skill". Matching
        // the substring rather than the exact name is what let PeoplePerHour work with no entry here.
        skillToken: "[class*='token'], [class*='skill']",
      };
    }

    /**
     * Label patterns for the `nearLabel` reader. Real regex sources — alternation is the point of them.
     *
     * These are regexes, not literals: `nearLabel` used to escape its argument on the way in and not on
     * the way out, so every pattern carrying a `|` or a `?` silently matched nothing. Ten of them did.
     */
    get labels() {
      return {
        experience: "Experience Level",
        duration: "Project Length|Duration",
        hoursPerWeek: "Hourly|hrs/week",
        connects: "Connects required|Send a proposal for",
        posted: "Posted",
        interviewing: "Interviewing",
        invitesSent: "Invites sent",
        unansweredInvites: "Unanswered invites",
        lastViewed: "Last viewed by client",
        totalSpent: "total spent",
        hires: "hires?",
        activeHires: "active",
        jobsPosted: "jobs posted",
        hireRate: "hire rate",
        avgHourly: "/hr avg hourly rate paid",
        memberSince: "Member since",
        companySize: "employees|company size",
        reviews: "reviews?",
        timezone: "local time|Timezone",
        availability: "Availability|hrs/week",
        jobSuccess: "Job Success",
        rating: "Job Success|rating",
        totalEarnings: "Total earnings",
        totalJobs: "Total jobs",
        totalHours: "Total hours",
        // What a fixed-price page says when it is not hourly. Read from the page text, because the two
        // words are the only thing distinguishing the type on a site with no attribute for it.
        hourlyWord: "hourly|per hour|/hr",
      };
    }

    sel(name) {
      const value = this.selectors[name];
      return Array.isArray(value) ? value : [value].filter(Boolean);
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
     *
     * A method rather than a shared function because reading a DOM is the per-marketplace part: a site
     * that hides its login behind something other than a header link, or that has no header at all, wants
     * a different answer rather than a bolt-on to a shared one. Nothing overrides it yet — every check
     * below runs off the platform table, which all three marketplaces fill in — and the one difference
     * that exists, Upwork's challenge wording, is expressed through `challengeSigns` because it is a
     * word and not an algorithm. The point is that the seam is here when a site earns it.
     */
    sessionState() {
      const platform = this.platform;
      // The *raw* text, deliberately — not the overlay-stripped view the field readers use. A login wall
      // and a challenge notice are very often rendered as a dialog, which is exactly what that view
      // removes. Stripping here would hide the one thing this function exists to find, and the failure
      // would be silent: every page would read as "ok" while returning nothing.
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

      /**
       * A header offering to log you in, and carrying no link to your own profile.
       *
       * Two structural facts rather than any prose, which is what makes it safe. Every signed-in page of
       * these sites links your own profile from its header — that is how `findOwnProfile` works at all —
       * and a signed-out one offers Log in and Sign up in the same place instead. Neither claim depends
       * on words that appear in footers and referral banners all over a signed-in site: matching the text
       * alone calls a job feed with a footer, a referral banner, a cookie notice and a proposals page all
       * signed-out, and that mistake halts a whole run and tells the app your session is broken.
       *
       * This is the case that reads `upwork.com` itself correctly. It is not a job page and not a profile
       * page, so the page-type check was right to decline it — but "this page isn't one we read" is the
       * useless truth when the useful one is that nobody is signed in.
       */
      const header = [...document.querySelectorAll("header a[href], nav a[href]")];
      const offersLogin = header.some((a) => platform?.isLoginPage?.(absolute(a.getAttribute("href")) || ""));
      const showsYourProfile = platform?.ownProfileLink
        ? header.some((a) => {
            const href = absolute(a.getAttribute("href"));
            return href && platform.isProfilePage(href);
          })
        : false;
      if (offersLogin && !showsYourProfile) {
        return { status: "signed_out", why: "the header is offering to log you in" };
      }

      // A challenge page instead of the one we asked for. Which wording counts is the marketplace's own
      // business — the generic signs live on the base reader and Upwork adds its own in its own file —
      // so this asks rather than deciding. Title and text together, because an interstitial often says
      // everything it has to say in the title alone.
      const evidence = `${document.title}\n${text}`;
      if (this.challengeSigns.some((sign) => sign.test(evidence))) {
        return { status: "blocked", why: "served a challenge page instead" };
      }

      return { status: "ok", why: null };
    }

    /**
     * Wording that means a site served a challenge instead of the page.
     *
     * Generic here — Cloudflare's interstitial and the phrasings bot detection reaches for — because
     * none of it belongs to a marketplace. A site whose challenge says something of its own adds it
     * in its own file, which is what Upwork does.
     *
     * Matched against the title *and* the text, since an interstitial often says everything it has to
     * say in the title alone.
     */
    get challengeSigns() {
      return [
        /access denied|unusual (?:traffic|activity)|are you a (?:human|robot)|verify you are human/i,
        /^just a moment/i,
      ];
    }

    /** The name, tagline and location a page's `<title>` carries. Generic: it carries none. */
    fromTitle() {
      const parts = clean(document.title).split(/\s+-\s+/);
      return {
        name: parts[0] || null,
        // "Name - Tagline - Site" is common enough to be worth the guess; the last part is the site.
        tagline: parts.length > 2 ? parts[1] : null,
        city: null,
        country: null,
      };
    }
  }

  /**
   * Which reader belongs to which marketplace.
   *
   * A Map filled by the platform files rather than a table written here, so this file never has to
   * know which marketplaces exist. An unregistered site gets the base, which is not a fallback so
   * much as the honest answer: the generic reader is what a site with no special handling deserves,
   * and it works.
   */
  const byPlatform = new Map();

  return {
    Reader,
    register(id, Kind) {
      byPlatform.set(id, Kind);
    },
    for(id) {
      return byPlatform.get(id) || Reader;
    },
  };
})();
