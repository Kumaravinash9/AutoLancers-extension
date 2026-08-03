/**
 * Upwork, whose markup is the reason every generic fallback in the base exists.
 *
 * Its own file because its DOM is its own problem: `data-test` attributes that mark content on job
 * pages and navigation chrome everywhere else, a `<title>` written for search engines that carries
 * the tagline and location as a pair, and `air3-*` class names that get rewritten freely.
 *
 * A diagnostics dump from a live profile settled the approach. Every `data-test` on that page marked
 * navigation rather than content, there was no JSON-LD at all, and the structure was carried entirely
 * by headings a human reads. So the names below are the ones that *do* mark content, prepended to the
 * base's generic lists rather than replacing them — a rename degrades to the fallback, not to nothing.
 */
(() => {
  const { clean, headingLike, inSection } = globalThis.ALExtractKit;

  class UpworkReader extends globalThis.ALReaders.Reader {

    get selectors() {
      const base = super.selectors;
      return {
        ...base,
        jobTitle: ['[data-test="job-title"]', ...base.jobTitle],
        jobDescription: ['[data-test="job-description-text"]', '[data-test="Description"]', ...base.jobDescription],
        jobBudget: ['[data-test="BudgetAmount"]', '[data-test="budget"]', '[data-test="job-type-label"] + div'],
        jobType: ['[data-test="job-type-label"]', '[data-test="job-type"]'],
        jobSkills: ['[data-test="token"] span', '[data-test="skills"] a', 'a[href*="/nx/search/jobs/?q="]'],
        jobCategory: ['[data-test="category"]', '[data-test="job-category"]'],
        jobProposals: ['[data-test="proposals-tier"]', '[data-test="ClientActivity"] li'],
        jobExperience: ['[data-test="expertise"]', '[data-test="contractor-tier"]'],
        jobDuration: ['[data-test="duration"]'],
        clientCountry: ['[data-test="client-country"]', '[data-test="LocationLabel"]'],
        clientCity: ['[data-test="client-city"]'],
        clientRating: ['[data-test="buyer-rating"]', '[data-test="client-rating"]'],
        clientSpend: ['[data-test="client-spend"]'],
        clientMemberSince: ['[data-test="client-contract-date"]'],
        clientIndustry: ['[data-test="client-industry"]'],
        // The overview, which Upwork renders as a clamped block: a `.air3-line-clamp` wrapper around a
        // span carrying `text-pre-line`. Neither of the two entries that used to be here matched it —
        // there is no itemprop and no `about-me-section` — so the summary fell through to the meta
        // description, which is the search-engine blurb rather than what the person wrote. The
        // substring form is second so an air3 → air4 rename degrades instead of breaking; both older
        // guesses are kept last, since they cost nothing and may still be right on another layout.
        profileSummary: [
          "[itemprop='description']",
          ".air3-line-clamp .text-pre-line",
          "[class*='line-clamp'] .text-pre-line",
          '[data-cy="about-me-section"] p',
        ],
        // Replaces the base's selector instead of extending it, which is the exception to how every
        // other entry in this file works. `[class*='token']` matches the `air3-token-wrap` class on
        // the <ul> that holds the chips, so the generic rule returned the entire list as a single
        // 811-character "skill" — every name run together, plus "Close the tooltip" and the Wikipedia
        // blurbs from the hidden popovers. Adding a better selector in front does not help when the
        // worse one is still in the list.
        //
        // `.air3-token` is safe beside it: class names match as whole words, so it does not match
        // `air3-token-wrap`. Losing both names would leave skills empty rather than wrong, which is
        // the trade this file has always taken.
        skillToken: ".skill-name, .air3-token",
        // An education entry is a <strong> above two plain divs, with no heading and no list item
        // anywhere in it:
        //
        //   <strong role="presentation" class="mb-0">Institute of Technology (IIT) (BHU), Varanasi</strong>
        //   <div class="text-light">Bachelor of Technology (BTech), Computer science</div>
        //   <div class="text-light-on-inverse">2018-2022</div>
        //
        // So the base's "h4, h5, li" matched nothing and education came back empty on every real
        // profile. Only the <strong> is listed: the two divs below it are the degree and the years,
        // which are worth having but have nowhere to go — the field is a list of school names — and
        // matching them here would file each one as a separate school.
        sectionEntry: `strong[role='presentation'], strong.mb-0, ${base.sectionEntry}`,
        // The Connects balance, in a sidebar card whose heading holds both the word and the number:
        // `<h3>Connects: 0</h3>`. Anchored on the two `data-test` names rather than the heading level,
        // since `h5` here is a class and `h3` is the tag — those disagree on purpose in Upwork's own
        // markup, and picking either one would be picking the wrong one eventually.
        profileConnects: [
          '[data-test="sidebar-connects-card"] h3',
          '[data-test="connects-section"] h3',
        ],
      };
    }

    /**
     * Upwork's own challenge page, on top of the generic ones.
     *
     * This wording is theirs and nobody else's — it is what appeared when eight pages were read at
     * once, and recognising it is what lets a run stop rather than hammering through the rest into a
     * site that has just said it is unhappy. Added to the base's list rather than replacing it, so a
     * Cloudflare interstitial in front of Upwork is still caught.
     */
    get challengeSigns() {
      return [
        ...super.challengeSigns,
        /there was an error loading this page|please contact customer support/i,
      ];
    }

    /**
     * The linked-accounts card, which lists two different things in one place.
     *
     * A linked account is a `.title` with a `.since` and a `.username` beside it. An *unlinked* one is
     * a `<button>` holding a bare span — StackOverflow appears exactly like that when it has not been
     * connected — so anything that reads the card's text, or sweeps it for provider names, reports an
     * account the person does not have. Keying on `.title` is what separates them: the button carries
     * no such class, so it drops out without needing to be recognised.
     *
     * `data-qa` rather than a class, because the classes here are layout (`span-8`, `py-4x`) and the
     * one durable-looking name on the card is that attribute.
     */
    linkedAccounts() {
      const card = document.querySelector('[data-qa="linked-accounts"]');
      if (!card) return [];
      return [...card.querySelectorAll(".title")]
        .map((title) => {
          // The grid cell holding this account's own fields, so two linked accounts cannot borrow
          // each other's username.
          const cell = title.closest("[class*='span-']") || title.parentElement;
          const since = clean(cell?.querySelector(".since")?.textContent || "").replace(/^since\s*/i, "");
          return {
            provider: clean(title.textContent) || null,
            username: clean(cell?.querySelector(".username")?.textContent || "") || null,
            since: /^\d{4}$/.test(since) ? Number(since) : since || null,
          };
        })
        .filter((account) => account.provider)
        .slice(0, 10);
    }

    /**
     * The line under the name, which Upwork does not mark at all.
     *
     * Matched by shape: a capitalised heading ending in a role word. The `(?!.*\/hr)` is not
     * incidental — without it this matches Upwork's own rate heading, "$20.00/hr", and files it as the
     * tagline. Both of those facts are Upwork's markup, and both lived in the shared reader.
     *
     * PeoplePerHour needs none of it: its title carries the tagline, which the base already reads.
     */
    tagline() {
      return (
        headingLike(
          /^(?!.*\/hr)[A-Z][^$]{8,90}(Engineer|Developer|Designer|Consultant|Specialist|Manager|Architect|Writer|Marketer)/
        ) || super.tagline()
      );
    }

    /**
     * Each role is one heading — "Software Engineer - III | Ebay" — above its dates and a clamped
     * description. Splitting on the pipe separates the role from the employer; without it both
     * collapse into one string. The base returns nothing, because a pipe in a heading means that here
     * and means nothing anywhere else.
     *
     * Scoped to the Employment history section rather than swept from the whole page. The sweep it
     * replaces looked for *any* heading containing a pipe, so a portfolio piece or a certificate named
     * with one would have been filed as a job — and the entry's dates and summary, which sit beside
     * the heading rather than in it, were unreachable that way.
     */
    employment() {
      return inSection(this.sections.employment, "h4")
        .map((heading) => {
          const [role, company] = clean(heading.textContent).split("|").map(clean);
          // The entry's own card, so three jobs cannot borrow each other's dates.
          const card = heading.closest("[class*='card-section']") || heading.parentElement;
          const period = clean(card?.querySelector(".text-light-on-inverse")?.textContent || "");
          const summary = clean(card?.querySelector(".text-pre-line")?.textContent || "");
          return {
            title: role || null,
            company: company || null,
            period: period || null,
            summary: summary || null,
          };
        })
        .filter((role) => role.title)
        .slice(0, 25);
    }

    /**
     * Other experiences, which on most profiles is an empty prompt rather than a list.
     *
     * The empty state is a card holding an illustration, the line "Add any other experiences that help
     * you stand out" and an "Add an experience" button — no entry, and nothing saying so except the
     * absence of a heading. Anything that read this card's text would file Upwork's own encouragement
     * as something the freelancer has done, which is the same mistake as reading a "Show more" label
     * as a job title.
     *
     * Keying on the entry heading is what makes the empty state answer nothing without needing to be
     * recognised: there is no h4 in it at all. No pipe splitting here — these are not role/employer
     * pairs.
     */
    otherExperiences() {
      return inSection(this.sections.otherExperiences, "h4")
        .map((heading) => {
          const card = heading.closest("[class*='card-section']") || heading.parentElement;
          const summary = clean(card?.querySelector(".text-pre-line")?.textContent || "");
          return { title: clean(heading.textContent) || null, summary: summary || null };
        })
        .filter((entry) => entry.title)
        .slice(0, 25);
    }

    /**
     * Upwork shows three jobs and hides the rest behind "Show more (2)", with the count in its own
     * element. The hidden entries are not in the DOM at all, so reading three and reporting them as
     * the whole history is the failure this number exists to prevent.
     */
    employmentHidden() {
      const count = document.querySelector('[data-testid="show-more-count"]');
      if (!count) return null;
      const found = clean(count.textContent).match(/\d+/);
      return found ? Number(found[0]) : null;
    }

    /**
     * Upwork puts two promotions inside the certifications section: an offer of Connects and a prompt
     * to claim one. Connects are Upwork's own currency and exist on no other marketplace, so this
     * filter was the clearest case of one site's vocabulary sitting in shared code.
     */
    certifications() {
      return super.certifications().filter(
        (text) => !/Earn \d+ Connects|Claim certification/i.test(text)
      );
    }

    /**
     * Upwork prints the rate as its own heading — "$20.00/hr" — with nothing else identifying it.
     *
     * No itemprop, no label, no class that survives a redesign: the only thing that marks it is the
     * shape of the text. This lived in the shared reader for a while and was the only thing finding
     * Upwork's rate, which meant a rule written from one site's DOM ran against every site.
     *
     * After `super`, so a future itemprop wins over guessing from shape.
     */
    rateText() {
      return super.rateText() || headingLike(/^[$£€₹][\d,.]+\s*\/\s*hr/i);
    }

    /**
     * Upwork's own auth routes.
     *
     * The generic rule already catches /ab/account-security/login and /nx/signup, because both end in
     * a word it knows. SSO does not — a header link to /ab/account-security/sso is an offer to log in
     * that says neither "login" nor "signin" anywhere in it.
     */
    get loginSigns() {
      return [...super.loginSigns, /upwork\.com\/ab\/account-security\/sso/];
    }

    /**
     * "Name - Tagline - Upwork Freelancer from City, Country".
     *
     * Written for search engines, so it outlives redesigns that move every element on the page — and it
     * is the only place the city and country appear as a pair. An algorithm, not a selector, which is
     * why it is overridden rather than configured.
     */
    fromTitle() {
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
  }

  globalThis.ALReaders.register("upwork", UpworkReader);
})();
