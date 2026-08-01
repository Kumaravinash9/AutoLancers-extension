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
  const { clean } = globalThis.ALExtractKit;

  class PeoplePerHourReader extends globalThis.ALReaders.Reader {

    get labels() {
      return { ...super.labels, budget: "Budget|Price" };
    }
  }

  globalThis.ALReaders.register("peopleperhour", PeoplePerHourReader);
})();
