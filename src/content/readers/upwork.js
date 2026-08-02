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
  const { clean } = globalThis.ALExtractKit;

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
        profileSummary: ["[itemprop='description']", '[data-cy="about-me-section"] p'],
        skillToken: ".air3-token, " + base.skillToken,
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
