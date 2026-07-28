# AutoLancers — Chrome extension

Reads the marketplace page you have open and shows you exactly what it got. Optionally sends it to
AutoLancers to be scored and filed in your queue.

Supports **Upwork**, **PeoplePerHour** and **Fiverr**. Adding another is an entry in
`src/content/platforms.js` — the host, how a job id is written into its URLs, and which pages are
worth collecting. The readers themselves are shared: anchoring on headings, `itemprop` and link
shapes turned out to travel between sites, which is also what survived Upwork's markup matching
none of the attributes we first guessed.

### A note on Fiverr

Fiverr is a listing marketplace, not a bidding one — sellers publish gigs and buyers come to them,
and Buyer Requests were removed in 2023. There is no job feed to score there. What the collector
reads is your own side of it: your gigs, your orders, your briefs and your inbox. If you are looking
for jobs to bid on, Upwork and PeoplePerHour are the two that have them.

Part of AutoLancers, alongside `AutoLancers-backend` and `AutoLancers-frontend`. It works on its
own — scraping and copying needs no backend, no account and no token.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder — the one containing `manifest.json`

Selecting a subfolder such as `src/popup` gives *"Manifest file is missing or unreadable"*. Pick the
repo root.

That's the whole setup. Open a supported page, click the toolbar icon.

## What it reads

Only these, by explicit allowlist:

| Site | Profile | Job |
|---|---|---|
| Upwork | `/freelancers/~0abc…` | `/jobs/~021abc…` or `/jobs/Some-Title_~021abc…/` |
| PeoplePerHour | `/freelancer/…` | `/freelance-jobs/…-4123456` |
| Fiverr | `/your-username` | `/briefs/…` |

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
```

Fixtures are a copy of the *shape* of Upwork's markup, not a guarantee it still matches. Passing
tests plus red "not found" rows on a real page means the fixtures need updating.
