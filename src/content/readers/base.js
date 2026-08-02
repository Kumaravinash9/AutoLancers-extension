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
  const {
    clean, structuredData, visibleText, absolute,
    firstOf, headingLike, inSection, meta, textOfAll,
  } = globalThis.ALExtractKit;

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
        // Tried in order. Was a literal inside `readProfile` — the one field whose selector lived
        // nowhere a marketplace could reach it.
        profileAvatar: ['img[alt*="profile" i]', '[class*="avatar"] img'],
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
        // Both were bare regexes inside `readJob`, so a site saying "Payments verified" or listing
        // "Quotes" instead of "Proposals" had no way to say so.
        paymentVerified: "payment (method )?verified",
        proposals: "Proposals",
      };
    }

    /**
     * The words a marketplace heads its profile sections with.
     *
     * The third map, beside `selectors` and `labels`, and the one that was missing: six section names
     * were English literals inside the shared readers — "Skills", "Work history", "Certifications" —
     * so a site that writes any of them differently lost that whole field with nothing to override.
     *
     * They are patterns, like `labels`: "Work history|Employment" is a legitimate value.
     */
    get sections() {
      return {
        skills: "Skills",
        languages: "Languages",
        portfolio: "Portfolio",
        workHistory: "Work history",
        education: "Education",
        certifications: "Certifications",
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

      if (this.isLoginUrl(location.href)) {
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
      const offersLogin = header.some((a) => this.isLoginUrl(absolute(a.getAttribute("href")) || ""));
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

    /**
     * URL shapes that mean "this is where you log in".
     *
     * Generic, and deliberately anchored to the *last* path segment rather than the first: every one
     * of these sites names its auth routes login/signin/signup/register/join, but they disagree
     * completely about what comes before. Upwork serves /ab/account-security/login, PeoplePerHour
     * serves /site/login, Fiverr serves /login. A matcher written from one site's shape silently fails
     * on the others — which is exactly what happened, and why this now lives here.
     *
     * The trailing `[/?#]|$` is what keeps "register" from matching a job titled "build a registration
     * system". A site with a route these words do not describe adds it in its own file.
     */
    get loginSigns() {
      return [/\/(?:log-?in|sign-?in|sign-?up|register|join)(?:[/?#]|$)/i];
    }

    /**
     * Does this URL take you to a login page?
     *
     * Asked of the reader rather than the platform table, because the answer is read off a page — the
     * href of a header link — and reading pages is what a reader is for.
     */
    isLoginUrl(url) {
      return Boolean(url) && this.loginSigns.some((sign) => sign.test(url));
    }

    /**
     * The text carrying the hourly rate — "$12/hr", "£45.00/hr".
     *
     * Generic: whatever the site marks as a price. A marketplace that prints its rate somewhere no
     * markup identifies says so in its own file, which is what Upwork does.
     */
    rateText() {
      return firstOf(this.sel("profileRate"));
    }

    /**
     * The skills listed on a profile.
     *
     * Scoped to a "Skills" section first, because a chip selector loose enough to match every site is
     * also loose enough to match related-search links and category tags elsewhere on the page. The
     * unscoped sweep is the fallback for a site that gives the section no heading — capped, since at
     * that point the selector is the only thing keeping this honest.
     */
    skills() {
      const scoped = inSection(this.sections.skills, this.selectors.skillToken)
        .map((node) => clean(node.textContent))
        .filter(Boolean);
      return scoped.length ? [...new Set(scoped)] : textOfAll([this.selectors.skillToken], 60);
    }

    /**
     * The skills on a *job* page — the selector first, then the section.
     *
     * Separate from `skills()` because the order is reversed: a job page that marks its skills is
     * trusted over a heading, while a profile's chips are usually unmarked. Both used to be written
     * out longhand in their own function, one of them twice.
     */
    jobSkills() {
      const marked = textOfAll(this.sel("jobSkills"));
      if (marked.length) return marked;
      return [...new Set(
        inSection(this.sections.skills, this.selectors.skillToken)
          .map((node) => clean(node.textContent))
          .filter(Boolean)
      )].slice(0, 30);
    }

    languages() {
      return [...new Set(
        inSection(this.sections.languages, `li, ${this.selectors.skillToken}`)
          .map((node) => clean(node.textContent))
          .filter(Boolean)
      )].slice(0, 20);
    }

    portfolio() {
      return inSection(this.sections.portfolio, "a[href]")
        .map((a) => ({
          title: clean(a.getAttribute("aria-label") || a.textContent) || null,
          url: absolute(a.getAttribute("href")),
          image: absolute(a.querySelector("img")?.getAttribute("src")),
        }))
        .filter((entry) => entry.title || entry.image)
        .slice(0, 25);
    }

    workHistory() {
      return [...new Set(
        inSection(this.sections.workHistory, "h4, h5, li")
          .map((node) => clean(node.textContent))
          .filter((text) => text && text.length > 3)
      )]
        .slice(0, 25)
        .map((title) => ({ title }));
    }

    education() {
      return [...new Set(
        inSection(this.sections.education, "h4, h5, li").map((n) => clean(n.textContent)).filter(Boolean)
      )]
        .slice(0, 10)
        .map((school) => ({ school }));
    }

    certifications() {
      return [...new Set(
        inSection(this.sections.certifications, "h4, h5, li")
          .map((node) => clean(node.textContent))
          .filter(Boolean)
      )].slice(0, 20);
    }

    /**
     * Past roles. Empty here, because there is no generic way to tell a job title from any other
     * heading — the site that can tell says how in its own file.
     */
    employment() {
      return [];
    }

    /** The line under the name. Generic: whatever the `<title>` carries. */
    tagline() {
      return this.fromTitle().tagline;
    }

    avatarUrl() {
      for (const selector of this.sel("profileAvatar")) {
        const src = document.querySelector(selector)?.src;
        if (src) return absolute(src);
      }
      return meta("og:image");
    }

    /** Whether the client has a verified payment method — the words the site uses to say so. */
    paymentVerified() {
      return new RegExp(this.labels.paymentVerified, "i").test(this.text);
    }

    /** The bid count written into the page text, where no attribute marks it. */
    proposalCount() {
      const found = this.text.match(
        new RegExp(`${this.labels.proposals}[^0-9]{0,40}(\\d+)\\s*(?:to|–|-)?\\s*(\\d+)?`, "i")
      );
      return found ? Number(found[2] || found[1]) : null;
    }

    /**
     * A job title taken from the document title, with the marketplace's own name trimmed off it.
     *
     * The name comes from the platform entry, so this strips whichever site you are actually on. It
     * used to be a regex naming Upwork, PeoplePerHour and Fiverr together, inside the function that
     * runs for all three — a fourth marketplace would have silently kept its suffix.
     */
    jobTitleFallback() {
      const site = this.platform?.label;
      const title = document.title;
      return clean(site ? title.replace(new RegExp(`\\s*[-|]\\s*${site}.*$`, "i"), "") : title);
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
