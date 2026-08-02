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
