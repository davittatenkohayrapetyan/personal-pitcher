import type { AtsId } from './types';

/**
 * Which applicant tracking system a company is on, read off its careers page.
 *
 * ## Detection is by marker, never by name
 *
 * This whole module exists because of one morning's evidence (§9, §1.2): three
 * name-based guesses at Align Technology's ATS — Lever, Greenhouse, Ashby —
 * all returned 404, and the real answer came from one grep of the careers page
 * for `pinpointhq.com`. A slug guessed from a company name is a plausible URL
 * that nobody has verified, and a watch list full of those is worse than a
 * short one: every run pays for them and nobody notices they return nothing.
 *
 * So nothing here is derived from the company's name. Every result comes from
 * a string the page itself contains — an embed script, an apply link, a board
 * URL — and the slug is whatever that string carries.
 *
 * ## It returns a ranked list, not an answer
 *
 * A real careers page is not tidy. It can carry an analytics reference to one
 * ATS and its actual board on another; an aggregator's posting page carries the
 * employer's apply link *and* a sidebar of unrelated jobs on three other
 * boards. Picking one marker and committing to it is exactly the detector that
 * works on the two boards it was written against and fails on the third.
 *
 * So this returns every detection it can construct an endpoint for, best first,
 * and `verify.ts` decides by *calling* them: the first one that returns a
 * posting the adapter can parse is the answer. Detection proposes; the endpoint
 * disposes.
 *
 * ## Two guards against detecting somebody else's board
 *
 * Both are only armed when the page being read is a third party's — an
 * aggregator posting page, where links to other companies' boards are the norm
 * rather than a surprise:
 *
 *  - **The slug has to resemble the company name.** This is not name-based
 *    guessing in reverse: the slug still comes from the page, and the name is
 *    only used to *reject*. "Align Technology" accepts `aligntech`; a sidebar
 *    link to `jobs.lever.co/someone-else` is dropped and logged, which is the
 *    outcome §12 wants visible rather than silent.
 *  - **Pinpoint's endpoint is not inferred from the page's own origin.**
 *    Pinpoint publishes at `{careers-origin}/postings.json`, so reading a
 *    Pinpoint marker on a page and taking that page's origin only works when
 *    the page *is* the company's careers page. On an aggregator it would
 *    produce `https://remotive.com/postings.json`. `allowOriginFallback` is
 *    opt-in for that reason.
 *
 * ## ATSs we can recognise but not monitor
 *
 * §9 lists `smartrecruiters` among the markers and `eightfold` is a valid
 * `AtsId` with no adapter. Neither can be verified, because verification means
 * calling the endpoint the 08:00 run would call and there is no such adapter to
 * call it with — so they are reported separately rather than dropped as "no
 * marker". The two say different things to whoever reads a week of discovery
 * logs: no marker means detection failed, unsupported means it worked and the
 * answer was an ATS this system cannot read yet.
 */

/** One way in, with the endpoint it implies. `marker` is why, for the log. */
export interface Detection {
  ats: AtsId;
  /** The endpoint an adapter will be called with, verbatim. Never reassembled later. */
  endpoint: string;
  /** The board's human page, for the card and for re-detection when it moves. */
  careersUrl: string;
  /** Which pattern fired — `greenhouse-embed`, `workday-url`. Stable, so it can be counted. */
  marker: string;
  /** The substring that matched, bounded. What makes a detection auditable. */
  evidence: string;
  /** Whatever the board calls the company. Empty for Pinpoint, which has none in the URL. */
  slug: string;
  /** Workday only: the adapter builds detail and public URLs from these. */
  workday?: { origin: string; tenant: string; site: string };
}

export interface DetectionResult {
  /** Best first. Empty means no marker was found at all. */
  detections: Detection[];
  /**
   * ATSs recognised and not supported — `smartrecruiters`, `eightfold`.
   * Reported rather than dropped, so "detection is failing" and "we cannot read
   * that board" stay distinguishable in the log (§12).
   */
  unsupported: string[];
}

export interface DetectOptions {
  /**
   * The page is the company's own careers page, so its origin may be used for
   * an ATS that publishes relative to it (Pinpoint), and links on it are not
   * assumed to belong to anyone else.
   *
   * False for a third party's page — an aggregator's posting, say — which is
   * where both guards in this module's header apply.
   */
  allowOriginFallback?: boolean;
  /** Used only to *reject* a slug that belongs to a different company. Never to build one. */
  companyName?: string;
}

/** Bounded like `geo.ts`'s: a log line is a clue, not a copy of the page. */
const EVIDENCE_BUDGET = 120;

/**
 * Hosts that are part of an ATS's own plumbing rather than a company's board.
 *
 * `assets.pinpointhq.com` is on every Pinpoint careers page and names no
 * company; treating it as a slug would produce a board called "assets".
 */
const NOT_A_SLUG = new Set([
  'assets',
  'cdn',
  'static',
  'www',
  'app',
  'api',
  'help',
  'support',
  'embed',
  'js',
  'v1',
  'en-us',
  // `…myworkdayjobs.com/wday/cxs/…` also matches the shape of a public board
  // URL, and reading `wday` as the site name produces a plausible endpoint that
  // 404s. The `workday-cxs` pattern above has already read that URL properly.
  'wday',
]);

interface Pattern {
  marker: string;
  ats: AtsId;
  pattern: RegExp;
  /** Builds the detection from a match, or returns null when the match is not usable. */
  build: (match: RegExpExecArray, pageUrl: string) => Omit<Detection, 'marker' | 'evidence'> | null;
}

/**
 * `https://boards.greenhouse.io/figma` → `figma`. Rejects the plumbing paths.
 *
 * The case is left exactly as the page wrote it, and only the comparison is
 * folded. Greenhouse was checked and is case-insensitive on the token — both
 * `mill` and `Mill` return 200 — but that was checked for one board of five,
 * and a slug retyped in a different case is a guess at an endpoint rather than
 * the one that was on the page. `mill.com/careers` really does redirect to
 * `job-boards.greenhouse.io/Mill`.
 */
function slugFrom(raw: string | undefined): string | null {
  const slug = (raw ?? '').trim();
  if (!slug || NOT_A_SLUG.has(slug.toLowerCase())) return null;
  return slug;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The patterns, in the order they are tried.
 *
 * Each one is a *URL shape a board actually serves*, not a brand name appearing
 * in prose: "we use Greenhouse" on an about page is not an endpoint, and a
 * detector that acted on it would propose a board that does not exist. The two
 * forms per ATS — the embed/API URL and the public board URL — are both here
 * because a careers page carries one or the other depending on whether it
 * hosts the board or links to it.
 */
const PATTERNS: Pattern[] = [
  {
    marker: 'greenhouse-embed',
    ats: 'greenhouse',
    // `boards.greenhouse.io/embed/job_board?for=figma`, and the `/js?for=` script form.
    pattern: /greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([a-z0-9_-]+)/i,
    build: (match) => {
      const slug = slugFrom(match[1]);
      return slug
        ? {
            ats: 'greenhouse',
            slug,
            endpoint: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
            careersUrl: `https://job-boards.greenhouse.io/${slug}`,
          }
        : null;
    },
  },
  {
    marker: 'greenhouse-api',
    ats: 'greenhouse',
    pattern: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i,
    build: (match) => {
      const slug = slugFrom(match[1]);
      return slug
        ? {
            ats: 'greenhouse',
            slug,
            endpoint: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
            careersUrl: `https://job-boards.greenhouse.io/${slug}`,
          }
        : null;
    },
  },
  {
    marker: 'greenhouse-board',
    ats: 'greenhouse',
    // Three hosts are live, not two: `boards.greenhouse.io` is the older one,
    // `job-boards.greenhouse.io` is what new boards are served from, and
    // `job-boards.eu.greenhouse.io` is the EU-resident variant — JetBrains is
    // on it. The whole host is captured so `careersUrl` points back at the page
    // that actually exists; rewriting an EU board's link to the US host would
    // put a 404 on the card. The API host is the same for all three, which is
    // why `endpoint` does not vary.
    pattern: /((?:job-)?boards(?:\.eu)?\.greenhouse\.io)\/([a-z0-9_-]+)/i,
    build: (match) => {
      const slug = slugFrom(match[2]);
      return slug
        ? {
            ats: 'greenhouse',
            slug,
            endpoint: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
            careersUrl: `https://${match[1].toLowerCase()}/${slug}`,
          }
        : null;
    },
  },
  {
    marker: 'lever-api',
    ats: 'lever',
    pattern: /api\.lever\.co\/v0\/postings\/([a-z0-9_-]+)/i,
    build: (match) => {
      const slug = slugFrom(match[1]);
      return slug
        ? {
            ats: 'lever',
            slug,
            endpoint: `https://api.lever.co/v0/postings/${slug}?mode=json`,
            careersUrl: `https://jobs.lever.co/${slug}`,
          }
        : null;
    },
  },
  {
    marker: 'lever-board',
    ats: 'lever',
    pattern: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i,
    build: (match) => {
      const slug = slugFrom(match[1]);
      return slug
        ? {
            ats: 'lever',
            slug,
            endpoint: `https://api.lever.co/v0/postings/${slug}?mode=json`,
            careersUrl: `https://jobs.lever.co/${slug}`,
          }
        : null;
    },
  },
  {
    marker: 'ashby-api',
    ats: 'ashby',
    pattern: /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_.-]+)/i,
    build: (match) => {
      const slug = slugFrom(match[1]);
      return slug
        ? {
            ats: 'ashby',
            slug,
            endpoint: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
            careersUrl: `https://jobs.ashbyhq.com/${slug}`,
          }
        : null;
    },
  },
  {
    marker: 'ashby-board',
    ats: 'ashby',
    pattern: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i,
    build: (match) => {
      const slug = slugFrom(match[1]);
      return slug
        ? {
            ats: 'ashby',
            slug,
            endpoint: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
            careersUrl: `https://jobs.ashbyhq.com/${slug}`,
          }
        : null;
    },
  },
  {
    marker: 'workday-cxs',
    ats: 'workday',
    // The endpoint the careers page itself calls. Present in the page's own
    // network code, which is how it was found for NVIDIA in the first place.
    pattern:
      /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/wday\/cxs\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)/i,
    build: (match) => {
      const origin = `https://${match[1]}.${match[2]}.myworkdayjobs.com`;
      const tenant = match[3];
      const site = match[4];
      return {
        ats: 'workday',
        slug: tenant,
        endpoint: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
        careersUrl: `${origin}/${site}`,
        workday: { origin, tenant, site },
      };
    },
  },
  {
    marker: 'workday-url',
    ats: 'workday',
    // `https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite`.
    // The locale segment is optional and must not be mistaken for the site,
    // which is why it is matched explicitly rather than skipped by position.
    pattern:
      /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:([a-z]{2}-[a-z]{2})\/)?([A-Za-z0-9_-]+)/i,
    build: (match) => {
      const origin = `https://${match[1]}.${match[2]}.myworkdayjobs.com`;
      const tenant = match[1];
      const site = slugFrom(match[4]) ? match[4] : null;
      if (!site) return null;
      return {
        ats: 'workday',
        slug: tenant,
        endpoint: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
        careersUrl: `${origin}/${site}`,
        workday: { origin, tenant, site },
      };
    },
  },
  {
    marker: 'pinpoint-subdomain',
    ats: 'pinpoint',
    // A board Pinpoint hosts under its own domain, which names the company and
    // needs no origin fallback.
    pattern: /https?:\/\/([a-z0-9-]+)\.pinpointhq\.com/i,
    build: (match) => {
      const slug = slugFrom(match[1]);
      return slug
        ? {
            ats: 'pinpoint',
            slug,
            endpoint: `https://${slug}.pinpointhq.com/postings.json`,
            careersUrl: `https://${slug}.pinpointhq.com`,
          }
        : null;
    },
  },
  {
    marker: 'pinpoint-hosted',
    ats: 'pinpoint',
    // Align's shape: the board is served from the company's own domain and the
    // only trace of the vendor is its asset host. The endpoint is therefore
    // relative to the *page*, which is only sound when the page is the
    // company's own — see `allowOriginFallback`.
    pattern: /pinpointhq\.com/i,
    build: (_match, pageUrl) => {
      const origin = originOf(pageUrl);
      return origin
        ? {
            ats: 'pinpoint',
            slug: '',
            endpoint: `${origin}/postings.json`,
            careersUrl: origin,
          }
        : null;
    },
  },
];

/**
 * Recognised, and not monitorable. Reported so the log can tell the difference
 * between a failed detector and an ATS with no adapter.
 */
const UNSUPPORTED: { name: string; pattern: RegExp }[] = [
  { name: 'smartrecruiters', pattern: /smartrecruiters\.com/i },
  { name: 'eightfold', pattern: /eightfold\.ai/i },
  { name: 'workable', pattern: /apply\.workable\.com/i },
  { name: 'recruitee', pattern: /\.recruitee\.com/i },
  { name: 'teamtailor', pattern: /\.teamtailor\.com/i },
  { name: 'personio', pattern: /jobs\.personio\.(?:com|de)/i },
];

/** Case, spacing and punctuation blind — the same fold the stores use. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Could this slug belong to this company?
 *
 * Containment either way, because both directions are ordinary: a board slug is
 * usually a shortening (`aligntech` for "Align Technology") and occasionally a
 * lengthening (`figma-inc`). A slug that is neither is somebody else's board on
 * a page that lists several.
 */
function slugResembles(slug: string, companyName: string): boolean {
  const board = fold(slug);
  const company = fold(companyName);
  if (!board || !company) return false;
  // Two characters of overlap is a coincidence, not a match: `ai` appears in
  // half the slugs on any board.
  if (board.length < 3) return false;
  return company.includes(board) || board.includes(company);
}

function clip(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > EVIDENCE_BUDGET ? `${text.slice(0, EVIDENCE_BUDGET)}…` : text;
}

/**
 * Reads one page — its URL and its HTML — and says which boards it points at.
 *
 * The URL is searched as well as the body, and that is not belt-and-braces: a
 * candidate generated from an aggregator feed often carries a posting URL that
 * *is* an ATS board URL (`jobs.lever.co/acme/…`), which detects with no fetch
 * at all. Passing an empty `html` is the supported way to ask that question.
 */
export function detectAts(html: string, pageUrl: string, options: DetectOptions = {}): DetectionResult {
  const haystack = `${pageUrl} ${html}`;

  const detections: Detection[] = [];
  const seen = new Set<string>();

  for (const entry of PATTERNS) {
    // `pinpoint-hosted` is the one pattern with no company in it, so it can only
    // be trusted on a page we already believe belongs to the company.
    if (entry.marker === 'pinpoint-hosted' && options.allowOriginFallback !== true) continue;

    const match = entry.pattern.exec(haystack);
    if (!match) continue;

    const built = entry.build(match, pageUrl);
    if (!built) continue;

    // On somebody else's page, a board that does not carry this company's name
    // is somebody else's board. On the company's own careers page the same
    // check would reject Align, whose board is `aligntech` on one page and
    // unnamed on another.
    if (
      options.allowOriginFallback !== true &&
      options.companyName &&
      built.slug &&
      !slugResembles(built.slug, options.companyName)
    ) {
      continue;
    }

    if (seen.has(built.endpoint)) continue;
    seen.add(built.endpoint);

    detections.push({ ...built, marker: entry.marker, evidence: clip(match[0]) });
  }

  const unsupported = UNSUPPORTED.filter((entry) => entry.pattern.test(haystack)).map(
    (entry) => entry.name,
  );

  // A slug that names the company outranks one that does not, whatever order
  // the patterns are in: on a page carrying two boards, the one called after
  // the company is the company's.
  const name = options.companyName;
  if (name) {
    detections.sort((a, b) => {
      const left = a.slug && slugResembles(a.slug, name) ? 0 : 1;
      const right = b.slug && slugResembles(b.slug, name) ? 0 : 1;
      return left - right;
    });
  }

  return { detections, unsupported };
}
