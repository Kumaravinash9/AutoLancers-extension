/**
 * PeoplePerHour, which needs almost nothing — and that is the finding, not an omission.
 *
 * The generic readers pull a complete PPH profile with no entry here at all: name, tagline, city,
 * country, rate with its currency, earnings, skills, languages, portfolio, work history, education.
 * The file exists so the next person looking for "where is PeoplePerHour handled" finds an answer
 * rather than concluding it is handled somewhere they have not looked.
 *
 * What it does add is label-anchored, not class-anchored. Its live markup has not been inspected from
 * a terminal — the site is behind a session — so inventing `data-test`-style names for it would be
 * guessing dressed as knowledge. Matching the words a human reads is the honest option, and the one
 * already proven to travel.
 */
(() => {
  class PeoplePerHourReader extends globalThis.ALReaders.Reader {

    /**
     * Where PeoplePerHour keeps the things it does not label.
     *
     * The rate is the case that forced this. PPH renders it as an unmarked span whose two divs split
     * the amount from the unit — `<span class="member-cost"><div>$12</div><div>/hr</div></span>` — with
     * no itemprop, no heading and no adjacent label. So all three generic routes miss it: the base
     * looks for `[itemprop='priceRange']`, the fallback looks for a *heading* shaped like "$12/hr",
     * and the label search has no word to anchor to. The profile came back with a null rate and looked
     * complete.
     *
     * Prepended to the base's list rather than replacing it, so a redesign that adds an itemprop still
     * works, and this class name going away degrades to the generic answer instead of to nothing.
     */
    get selectors() {
      const base = super.selectors;
      return {
        ...base,
        profileRate: [".member-cost", ...base.profileRate],
        // Skills are links into its own freelancer search, not chips: `.widget-tag-list` holding
        // `a.tag-item` pointing at /hire-freelancers?skills=…. Neither class contains "token" or
        // "skill", so the generic selector matched nothing and profiles came back with no skills at
        // all. Scoped to the container on purpose — `.tag-item` alone would also collect category tags
        // elsewhere on the page.
        skillToken: `.widget-tag-list .tag-item, ${base.skillToken}`,
      };
    }

    get labels() {
      return { ...super.labels, budget: "Budget|Price" };
    }

    /**
     * PeoplePerHour keeps every auth route under `/site/`: `/site/login`, `/site/register`.
     *
     * The same prefix its own page list already uses for `/site/saved-jobs` and `/site/proposals`, and
     * the reason a logged-out visit went undetected — the old matcher demanded `peopleperhour.com/login`
     * and this site has no such URL, so the header sat there offering "Log in" while the extension
     * collected an empty page and reported it as a quiet day.
     *
     * The generic rule in the base now catches both of these on its own. They are still written down
     * here because these are the routes a real signed-out page was observed to carry, and a matcher
     * that happens to work is worth less than one that was checked.
     */
    get loginSigns() {
      return [...super.loginSigns, /peopleperhour\.com\/site\/(?:login|signin|register)/];
    }
  }

  globalThis.ALReaders.register("peopleperhour", PeoplePerHourReader);
})();
