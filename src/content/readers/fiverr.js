/**
 * Fiverr, parked. Kept whole so re-enabling stays one flag — see `enabled: false` in platforms.js.
 *
 * Empty because a gig is not a job posting: sellers publish offers and buyers come to them, so there
 * is nothing here to score. What its pages hold is your own side of it, which is read as rows and
 * needs no selectors of its own.
 */
(() => {
  class FiverrReader extends globalThis.ALReaders.Reader {

  }

  globalThis.ALReaders.register("fiverr", FiverrReader);
})();
