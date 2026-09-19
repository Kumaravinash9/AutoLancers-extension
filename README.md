# AutoLancers — Chrome extension

Reads the marketplace page you have open and shows you exactly what it got. Optionally sends it to
AutoLancers to be scored and filed in your queue.

Supports **Upwork** and **PeoplePerHour**. Fiverr is **parked** — see below. Adding another is an entry in
`src/content/platforms.js` — the host, how a job id is written into its URLs, and which pages are
worth collecting. The readers themselves are shared: anchoring on headings, `itemprop` and link
shapes turned out to travel between sites, which is also what survived Upwork's markup matching
none of the attributes we first guessed.

### A note on Fiverr

Fiverr is a listing marketplace, not a bidding one — sellers publish gigs and buyers come to them,
and Buyer Requests were removed in 2023. There is no job feed to score there, which is why it is
**parked**: `enabled: false` on its entry in both platform tables, and its two `host_permissions`
lines commented out in `manifest.json`.

Nothing is deleted. Every reader, selector and page it had is still present and still tested — the
reserved-word list that tells `fiverr.com/<username>` from `fiverr.com/inbox` has its own passing
checks. Re-enabling is: uncomment two lines, flip one flag.

Those three things move **together**, and a test enforces it. A platform recognised but not permitted
is what produces *"Cannot access contents of url"* after the popup has already offered to read the
page, so claim and permission are never allowed to disagree.

Part of AutoLancers, alongside `AutoLancers-backend` and `AutoLancers-frontend`. It works on its
own — scraping and copying needs no backend, no account and no token.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder — the one containing `manifest.json`

Selecting a subfolder such as `src/popup` gives *"Manifest file is missing or unreadable"*. Pick the
repo root.

That's the whole setup. Open a supported page, click the toolbar icon.

## When you're not signed in

The failure mode this guards against has no symptom. Signed out of Upwork, every find-work URL
redirects to a login page that **loads perfectly** — so the tab reaches `complete`, nothing throws,
and the job reader finds no `/jobs/~id` links on it and returns an empty list. Left alone, a
logged-out collection reports **"0 found" on all eight pages**, which reads exactly like a quiet day
on the marketplace, and files `stored: 0` to the backend as though that were true.

So every read checks the page before parsing it, and reports one of three states:

| State | What it means | What happens |
|---|---|---|
| `ok` | it's the page we asked for | read it |
| `signed_out` | a login wall | the run **stops**, the popup says so, the backend is told |
| `blocked` | a challenge or rate limit | the run **stops** — more pages makes it worse |

Three signals, none of them prose alone:

1. **The URL** — a redirect to a known login path. Unambiguous when it fires, because a redirect is a
   fact rather than an inference.
2. **The header** — it offers Log in, and carries no link to your own profile. Structural, and it's
   what reads `upwork.com` itself correctly: that page is neither a job nor a profile, so the page-type
   check declines it, but "isn't one we read" is the useless truth when the useful one is that nobody
   is signed in. A signed-in header *always* links your profile — it's how `findOwnProfile` works.
3. **A password field beside a "log in" heading** — for a wall rendered in place without the URL
   changing.

Plus Upwork's own challenge wording (*"There was an error loading this page"* — the text that appeared
when eight pages were read at once).

**Never the words alone.** "Log in" and "Sign up" sit in the footer of every page on these sites, in
referral banners, and in cookie notices — matching on text called a job feed, a referral banner, a
cookie notice and a proposals page all signed-out, four for four. That mistake is expensive: it halts
the whole run and tells the app your session is broken while you're sitting there logged in.

The run halts on the **first** page that hits a wall. There's nothing behind it, so the remaining
seven are seven pointless requests — and if the state is `blocked`, seven requests to a site that has
just said it's unhappy, which is the worst possible response to bot detection.

The status is also sent to the backend, and `GET /ingest/status` serves it back per platform. Since
the AutoLancers frontend is open in the same browser, that's where *"your Upwork session expired"*
belongs — next to the board of scores that is quietly going stale.

## Whose profile is it?

**No URL pattern can tell your profile from anyone else's.** `upwork.com/freelancers/~01…` matches
every freelancer on the site. That matters because `POST /ingest/profile` mirrors what it's sent onto
*your* profile row — the one every score in the app is computed from — so a stranger's profile sent
there overwrites your name, tagline, rate and skills with theirs.

The marketplace itself knows which one is yours, and it puts a link to it in its own account menu.
`findOwnProfile()` follows that link — header and account-menu scopes only, because a profile link
inside a job card or a review is *someone else's*. Nothing is configured and nothing is hardcoded to
one account: it answers for whoever is signed in, on whatever machine.

Three ways to find it, cheapest first:

1. **The account menu** on whatever page you're already on — free, no navigation. Header and
   account-menu scopes only, because a profile link inside a job card or a review is *someone else's*.
2. **A link that says it's yours**, anywhere on the page. "Your profile" and "View my profile" are
   phrases a marketplace only ever writes about the signed-in person, so the words identify you where
   a scope can't. A link with someone else's name on it cannot match.
3. **A self-resolving URL**, where the platform has one — Upwork's `/freelancers/` with no id
   redirects to your own profile. Depends on nothing about the page's markup, so it survives a redesign
   that moves the header. It costs a navigation, which is why it's last.

Both marketplaces have a **My profile** page in the collector, ticked by default. PeoplePerHour needs
no URL for it at all: its account menu is in the header of every page, so step 1 answers from wherever
the collection already is — which is also why nothing here is hardcoded to one account.

Then it **verifies at the destination**. Following a link is not proof of arrival: a redirect, an
interstitial or a stale link lands you somewhere else, and this is the one page whose contents overwrite
the profile row every score is computed from. A profile that can't be confirmed as yours is skipped
with its reason on the row, and the job listings carry on collecting — an unidentifiable profile is no
reason to abandon a run that is otherwise working.

`readProfile()` then reports `is_own` by comparing the account id in the URL against the id that link
carries — by id, not by name, and not by whether an "Edit profile" button is showing. `null` means
undecidable, and the backend refuses a `null` exactly as it refuses a `false`: "probably yours" is not
a good enough reason to overwrite that row.

Fiverr needed a second fix here. A seller profile is `fiverr.com/<username>`, the same shape as most
of the site's own pages, and the old matcher excluded only gigs, briefs and categories — so `/inbox`,
`/orders`, `/settings` and `/users` all read as "a profile". A page misread as a profile gets scraped
as one. There's now a reserved-word list, erring towards "not a profile": a profile missed is a button
that doesn't appear, while a settings page mistaken for one is the wrong thing written into your row.

## What it reads

Only these, by explicit allowlist:

| Site | Profile | Job |
|---|---|---|
| Upwork | `/freelancers/~0abc…` | `/jobs/~021abc…` or `/jobs/Some-Title_~021abc…/` |
| PeoplePerHour | `/freelancer/…` | `/freelance-jobs/…-4123456` |
| Fiverr | `/your-username` | `/briefs/…` |

Hosts are matched **exactly** — `www.upwork.com` and the bare `upwork.com`, nothing else. Not
"anything ending in upwork.com": `community.upwork.com` is a forum full of other people's posts and
`support.upwork.com` is help articles, so claiming them would be wrong on the merits. It was also
broken in practice — the host regex used to accept any subdomain while `host_permissions` granted only
`www.`, so the popup would recognise such a tab, offer to read it, and *then* fail with
*"Cannot access contents of url … must request permission to access this host"*. Recognising a page
you cannot read is worse than not recognising it, because the offer is already made by the time it
fails. A test now pins the two lists against each other in both directions.

Anything else — search results, message threads, settings — the popup declines and tells you which
pages it handles. This is an allowlist rather than a blocklist on purpose: "any upwork.com URL"
would quietly include pages holding other people's data. Adding a page type is a deliberate edit to
`PAGES` in `src/popup/popup.js`.

## How it reads

**Nothing runs until you click.** There is no `content_scripts` block in the manifest, so no code
of ours is present on any page by default. Clicking the popup injects `src/content/extract.js` into
the tab you already have open, via `activeTab`, reads the DOM once, and stops. Nothing runs in the
background, nothing follows links, nothing paginates.

That constraint is the point. Upwork's automation policy targets tools that watch the site on your
behalf, and enforcement lands on **your** account. A tool you point at one page you opened yourself
is a different thing — but only as long as it stays that way, so please don't add a crawler.

### Fields

**Job** — title, id, category, posted; type, budget, experience level, project length, hours/week,
connects; proposals, interviewing, invites sent, unanswered invites, last viewed by client; skills;
description. Plus the **client**: country, city, rating, reviews, total spent, hires, jobs posted,
hire rate, average hourly paid, member since, payment verified, company size, industry — a client's
history is what tells you whether a bid is worth the connects.

**Profile** — name, handle, tagline, country, city, timezone, availability, languages; rate and
total earnings; rating, reviews, job success, total jobs, total hours; skills; and the repeating
blocks: portfolio, work history with feedback, employment, education, certifications.

### One base reader, one file per marketplace

`src/content/extract.js` holds a `Reader` base class carrying the **generic** implementation —
structured data, `itemprop`, headings, and the words next to a visible label — with a subclass per
marketplace. A subclass exists for one of exactly two reasons:

1. It knows a **better selector** than the base can guess at. Upwork's `data-test` attributes are the
   whole of that, and they're *prepended* to the generic list rather than replacing it, so a rename
   degrades to the fallback instead of to nothing.
2. It needs a **different algorithm**. Upwork's `<title>` carries the tagline and location in a shape
   no other site uses, so `fromTitle()` is overridden rather than parameterised.

Anything that is neither belongs in the base, once. Every difficult bug in this file has been in
site-neutral logic — walking a heading's section without swallowing the sidebar, telling prose from a
label, canonicalising two URL shapes into one id — and three copies means fixing each of those three
times. This repo has been bitten twice already by duplicated platform knowledge drifting apart.

`PeoplePerHourReader` is deliberately almost empty, and that's a finding rather than an omission: the
generic readers pull a **complete** PPH profile with no per-site entry at all. Its live markup hasn't
been inspected from a terminal, so what it does add is label-anchored — inventing `data-test`-style
names for a site nobody has looked at would be guessing dressed as knowledge.

A class rather than a selector table because of reason 2: a table can't override an algorithm.

```
src/content/
  extract.js              the readers themselves, and the machinery for walking a DOM
  readers/base.js         the generic Reader, plus the registry
  readers/upwork.js       data-test selectors, and a <title> only Upwork writes
  readers/peopleperhour.js  almost nothing, on purpose
  readers/fiverr.js       empty, parked
```

`executeScript({files})` evaluates classic scripts in order, each with its own top-level scope, so a
subclass in one file can't see a class declared inside a closure in another. The registry bridges
that: `base.js` publishes `Reader` and a `register` function on `globalThis`, each platform file
registers itself against its id, and `extract.js` asks for the one matching the page. Adding a
marketplace is a file plus a line in the injection list.

That list lives in two callers and is checked by a test — the order is the contract (`extract.js`
publishes the helpers `base.js` needs; `base.js` publishes the class the platform files extend), and
a path that doesn't exist otherwise fails at click time on a marketplace page.

### Cards sitting on top of the page

A "Boost your profile" card open over a real profile advertised *"Total earnings $250K"* and
*"Total jobs 999"* — and both won. The label readers scanned raw `innerText`, so the modal's marketing
figures beat the page's own `$40K` and `134`. Section walking had always excluded overlays; the
text-scanning readers never did. They now read one overlay-stripped view of the page, built once per
read.

They are **ignored, not dismissed.** Closing a card means clicking it, and a click on someone's
account is an action — it can accept cookies, silence a notification permanently, or opt them into
something. Everything here reads; the single deliberate exception is `clickTo`, which navigates
because that is its job. A test asserts the card is still on the page afterwards.

One deliberate exception in the other direction: `sessionState()` reads the **raw** page, because a
login wall or a challenge notice is usually *itself* a dialog. Stripping overlays there would hide the
one thing it exists to find, and the failure would be silent — every page would read as `ok` while
returning nothing.

Selectors are anchored on **headings and `itemprop`**, not class names. A diagnostics dump from a
live profile settled this: every `data-test` attribute on the page marked navigation chrome, none
marked content, there was no JSON-LD at all, and the structure was carried entirely by headings a
human reads — "Work history", "Employment history", "Portfolio". Class names (`air3-*`) get
rewritten freely; heading text does not. The `<title>` is the backstop, since it is written for
search engines and carries the tagline, which has no attribute of its own.

Each field tries structured data first, then `itemprop`, then a heading, then the text next to a
visible label — matching the words a human reads survives a class-name change,
which is the most common kind of drift. Money is normalised, so `$40K` becomes `40000` and
`1,240` becomes `1240`. **A field it cannot find comes back `null` and is shown as "not found" in red** — never
as a blank or a zero. That matters downstream: the backend skips a filter it has no input for, so a
missing budget means "unknown", while a zero would mean "free" and get the job rejected.

Upwork writes a job link two ways — bare id, or slug then id — and hangs a `referrer_url_path` on
both recording which page you came from. Stored URLs are canonicalised: query and trailing slash
dropped, so the same job collected from Best matches and from Saved jobs is one URL, not two, and
the tracking parameter is not kept.

Expect selectors to drift. Upwork changes its markup without notice; the red "not found" rows are
how you'll spot it. When they do, click **Copy diagnostics** — it dumps the page's structure
(attribute names, headings, repeated class names, sample text) so the selectors can be rewritten
from evidence rather than guesswork. Upwork returns 403 to anything but a real browser, so this is
the only way to see their live markup.

## Collecting several pages

**Collect my pages…** visits a fixed list of your own Upwork pages, reads each one, and closes it:

| Page | Read as |
|---|---|
| Best matches, Most recent, Saved jobs, Invites | job cards — id, title, **description**, skills, budget, proposals, age |
| Home | job cards plus page text |
| Contracts | contract rows |
| Reports (in progress) | report rows and totals |
| Message rooms | **room previews only** — off by default |

### Descriptions

A listing page shows a **truncated preview**, not the full posting — Upwork cuts it with a "more"
link. Each card's `description` is that preview, with the terms stripped out: a description is the
one block of prose on a card, so lines starting with money, "Proposals", "Posted" or an experience
level are excluded. `description_complete: false` marks it as partial, so nothing downstream mistakes
a preview for the whole posting.

Tick **Also open each job for its full description** to get the real thing. That opens each job's own
page, which is one page load per job on top of the listing pages, and also brings back the client
block and experience level. `description_complete` flips to `true` for the jobs it managed.

How it behaves, and why:

- **It only starts on a click.** There is no automatic trigger, no alarm, no timer, and nothing on
  install. An earlier version started when you arrived on Upwork; that is removed. The single entry
  point is the message the popup sends when you press Collect.
- **One page at a time by default**, with a randomised 4–9 second pause. Roughly 76 seconds for
  eight pages. Setting `concurrency: 0` in Settings reads them all at once in about 4 seconds —
  measured, and it tripped Upwork's bot detection in practice (see below).
- **It waits for the list to stop growing.** Upwork renders job cards as they arrive, so reading a
  fixed moment after load caught about a screenful and the rest of the page's own first batch landed
  unread. Waiting for the count to stop changing asks the question that matters — has the page
  finished? — and resolves as soon as the answer is yes. On a feed that renders 4 then 8 more, that is
  the difference between 4 jobs and 12.

- **Then it scrolls to the foot of the feed exactly once**, waits for whatever that brought, and puts
  the page back where it was. Upwork holds most of the feed back until you ask, so reading without
  scrolling reads a screenful of a list with forty jobs in it. One scroll is what a person does within
  seconds of landing.

  **Once is the point.** `loadMoreOnce` is a single statement rather than a loop with a limit of one,
  so "just raise the cap" isn't a one-character change. Scrolling until the feed stops giving is
  pagination — what the constraint below refuses — and the only difference between the two is a
  number, which is exactly why the number shouldn't exist. A test asserts it scrolls down once and
  back once. The scroll position is restored because in click-through mode that's a tab you're looking
  at.
- **It waits for each page to load** rather than sleeping a fixed interval. A sleep is wrong in both
  directions: too short and the reader runs against an empty DOM and reports zero with no error,
  too long and every run drags.
- **It follows no links.** The list is fixed; nothing is discovered, nothing is paginated.
- **It clicks through your open tab.** Upwork is a single-page app, so following its own nav links
  re-renders client-side — measured at **zero document requests** for a three-page run, against one
  full load per page when navigating by URL. No tab is created at all; the run uses the Upwork tab
  you already have open and leaves it where it finished.
- **Falls back to navigating**, in that same tab, when the link isn't on the current page — there is
  no path from Contracts to Saved jobs if the nav doesn't offer one. With no Upwork tab open at all,
  it opens one inactive tab and reuses it for every page.
- **Messages reads the room list only** — who and when, and the preview the list itself renders. It
  never opens a conversation. Those are two-party messages and half of that data belongs to someone
  who never agreed to any of this. It is off by default.

### Turning it off

See `DISABLE.md`. The strongest option is removing `https://www.upwork.com/*` from
`host_permissions` in `manifest.json` — after that the collector cannot reach the site at all,
because Chrome refuses rather than because the code agrees not to.

### What happened when this ran in parallel

Running all eight pages simultaneously triggered Upwork's bot detection. The symptom was
*"There was an error loading this page. Please contact customer support"* in Chrome, while the same
account logged in normally from a phone — a flagged **browser**, not an actioned account. It cleared
by itself after a while.

That is why the default is one page at a time. It is an observed result, not a precaution.

If it happens again: clear cookies and site data for upwork.com in Chrome and log in fresh; check a
different browser on the same machine to confirm the account is fine; and see `DISABLE.md` for
removing the extension's access to Upwork entirely while you diagnose.

### The honest warning

This is the part of the extension that most resembles what Upwork's automation policy prohibits.
The single-page reader is a tool you point at a page you opened; this visits pages on your behalf,
which is a different thing, and enforcement lands on **your account**. The pacing and the fixed list
lower the risk. They do not remove it.

If you add a `chrome.alarms` trigger to `src/background/worker.js`, you have crossed from "a tool I
ran" to "a bot that watches the site". That is the wrong side of the line.

## Telling the app directly

The extension and the AutoLancers app run in the same browser, so the interesting moment — you pressed
Collect and Upwork asked you to sign in — can reach an open dashboard tab without a backend round trip.

The mechanism is `externally_connectable`: the app's page opens a port to the extension and the
extension answers. **Nothing is injected into your own site** — the page initiates, the manifest's
`matches` list is the whole trust boundary, and the app works fine with the extension absent
(`chrome.runtime` simply isn't there).

```
app tab                                    extension
   |-- sendMessage("ping") --------------->|  installed? which version?
   |-- connect("autolancers") ------------>|  registers the port
   |<-- {type:"state", ...} ---------------|  current state, immediately on connect
   |<-- {type:"state", ...} ---------------|  and again on each page, halt, or finish
```

What crosses is deliberately small: whether a run is going, how many pages are done, how many were
filed, and whether reading is broken. Not the scraped rows — the app gets those from the backend, where
they're scored — and not the per-page checklist, which is the popup's business.

A web page can't discover an extension's id, and a "Load unpacked" build gets a different one per
machine. Find it at `chrome://extensions` and set `NEXT_PUBLIC_EXTENSION_ID` in the frontend.

**This does not replace the recorded status.** A port only reaches a tab that's open at that moment,
and during a collection you're looking at the marketplace, not at the dashboard — so the common case is
that nobody was listening. `capture_statuses` on the backend is what covers opening the app an hour
later, which is the case the whole idea exists for. The live channel is for immediacy; the record is
for truth.

## Sending to AutoLancers (optional)

Leave the token empty and the extension is a scraper with a Copy button. Add one and a
**Send to AutoLancers** button appears, which scores the job against your profile and files it in
your queue.

The token is an **AutoLancers** token, not an Upwork one. The extension runs on Upwork's origin,
where your AutoLancers session cookie is not sent, so it needs its own credential. Issue one:

```bash
# sign in, keeping the session cookie
curl -s -c /tmp/al.txt -X POST localhost:8010/accounts/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"…"}'

# mint a token — the plaintext is in this response and nowhere else, ever
curl -s -b /tmp/al.txt -X POST localhost:8010/accounts/tokens \
  -H 'content-type: application/json' \
  -d '{"name":"Chrome extension"}'
```

Paste it into the extension's **Settings**, then hit **Test connection** — it reports "backend
unreachable" and "token rejected" separately, because those need different fixes.

Revoke with `DELETE /accounts/tokens/{id}`. Tokens are stored as a SHA-256 hash, so a lost one
cannot be recovered — issue another and revoke the old.

Captured postings are stored with `discovery_method = PASTE_IN`, distinct from the poller's
`API_POLL`, so "where did this come from?" always has a true answer.

### Filing a whole collection

With a token set, each collected page is sent as it finishes — `POST /ingest/collection`, one request
per page. Per page rather than one payload at the end, so a run you cancel keeps everything it
already read.

Every job-listing page lands in the same table. **Best matches and Most recent are not two kinds of
thing** — they are two places the marketplace shows the same postings — so both become `projects`,
deduped on `(platform, external_id)`: the marketplace's own id, taken from the link's `href` and
never from text. A job on both pages is one row, scored once. Which page it was seen on is recorded
in `bid_information.source_page`, not in the identity of the row.

The payload is raw on purpose. `budget` goes as `"$500.00 - $1,000.00"` and `posted` as
`"3 hours ago"`, because parsing those belongs in one tested place — `app/services/capture.py` in the
backend — rather than duplicated in JavaScript:

```json
{
  "freelance_platform": "upwork",
  "page_key": "best_matches",
  "page_label": "Best matches",
  "reads": "jobs",
  "page_url": "https://www.upwork.com/nx/find-work/best-matches",
  "scraped_at": "2026-07-30T12:00:00.000Z",
  "is_llm_required": false,
  "items": [ /* readJobCards() output, verbatim */ ],
  "page_text": ""
}
```

`scraped_at` is the **reader's** clock, not the sender's: relative ages are resolved against it, so a
push that waited doesn't shift every posted date. A field the selectors didn't find travels as
`null`, never as zero or an omission — the backend treats null as "unknown" and a partial scrape can
never blank a value an earlier, better one found.

`is_llm_required` is the extension asking for an LLM reading of `page_text`; it's a request, not an
instruction. The backend still skips the call when nothing is actually missing, and the response says
whether it ran. Two rules bound it:

- **It only fills what the selectors left empty.** A model asked to read a page it can mostly see
  will restate a title slightly differently; letting that win would make the same job's title flicker
  between collections.
- **It cannot introduce a job.** Readings are matched back by **title**, because a job's id lives in
  its link's `href` and the model only ever sees visible text. An item no scraped row matches is
  dropped and counted — with no id there'd be nothing to dedupe the next collection against, so it
  would arrive as a new orphan project every single time.

The response is counts, not a tick, and the checklist shows them per page:

```json
{"received": 24, "stored": 22, "created": 19, "duplicates": 1, "skipped_no_id": 1,
 "llm_used": true, "llm_model": "gemini-2.5-flash", "llm_fields_filled": 14, "llm_unmatched": 0}
```

Twelve links found and none stored is a broken selector, and "sent ✓" is precisely the wrong thing to
say about it. Filing is also reported separately from reading throughout: a page can be read
perfectly and still fail to file — an expired token, a backend that isn't running — and one shared
status would send you to debug the wrong half.

Ticking **Also open each job for its full description** re-files the pages afterwards, once the whole
brief is in hand. The upsert is on `(platform, external_id)`, so that updates the rows already stored
rather than making twins of them.

### Pages with no modelled home

`contracts`, `pph_proposals`, orders and message rooms don't map onto a table yet — a proposal needs a
resolved project FK, a contract needs a table of its own — but those rows only exist while you happen
to be on the page. Deferring the decision *and* discarding the data would mean a month of history
thrown away, so they're **accumulated whole** in `page_captures`: the reader's rows verbatim, plus the
visible text they're a partial reading of. v2 extracts whatever shape it settles on, over history
rather than from scratch.

An unchanged re-collection bumps `times_seen` instead of filing another copy; a changed page is a new
row, because that difference is the value of keeping them. The checklist says `6 kept` for these, not
`6 stored` — they're queryable, but nothing reads them yet.

With the AI toggle on, those pages also get an LLM reading stored **beside** the raw rows, never
instead of them — a model's interpretation isn't evidence, and a later, better prompt should get to
re-read the original. Message rooms are the deliberate exception: they're two-party data, half of it
belonging to someone who never agreed to any of this, so they accumulate but are never sent to a
model.

## Tests

```bash
npm install
npm test
```

Runs the real extractor against fixture pages in `test/fixtures/` — no network, and Upwork is never
touched. It covers the parsing, the fallbacks, and the contract that an absent field stays `null`:

```
job page:      id · title · work_type · budget · skills · proposals · posted_at · experience
               level · project length · category · interviewing · invites · client country
               · client rating · client spend (K expanded) · payment verified
profile page:  name · tagline · rate · country · city · availability · languages · skills
               · rating · reviews · job success · earnings (K expanded) · jobs · hours
               · portfolio (+absolute URLs) · work history · employment · education · certs
empty page:    budget absent not zero · proposals absent not zero · skills empty list
               · client block all-null not zeroes
payload:       the nine named parameters · platform travels · items come from `reads`
               · scraped_at is the reader's clock · no page text unless the AI is wanted
               · rows pages send rows · summaries read as counts
```

The backend half of the contract is tested there: `pytest tests/test_capture.py` in
`AutoLancers-backend` covers the money/relative-time parsing, the dedupe, and the rule that an LLM
reading can only fill a gap.

Fixtures are a copy of the *shape* of Upwork's markup, not a guarantee it still matches. Passing
tests plus red "not found" rows on a real page means the fixtures need updating.

`npm test` then loads the extension into a real Chromium (`test/load.mjs`) and checks that it comes up
at all — a malformed manifest, a service worker that throws on its first tick, and an unresolvable
import all present identically, as an extension that is simply dead with the reason buried in
`chrome://extensions`. It also asks **Chrome** whether each host may be read and compares that against
what the code claims to support, which is the only way to catch the two disagreeing:

```
host                      chrome allows   code claims
www.upwork.com            true            true
upwork.com                true            true
community.upwork.com      false           false
```

Run them separately with `npm run test:readers` and `npm run test:load`.
