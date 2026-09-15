import type { SourceFetch, SourceRecord } from '../types';
import { githubToken, githubUser } from '../config';
import { canSkip, readSourceState } from '../sourceState';

/**
 * GitHub adapter — feeds `data/projects.json`.
 *
 * The easiest source on the list and the one that pays off most: the projects
 * section is what actually goes stale, and GitHub publishes everything needed to
 * notice, over a documented API, with no ToS problem and no scraping.
 *
 * ## Reading from the default branch only
 *
 * Every content read here is pinned to the repository's `default_branch`. A
 * README is untrusted text that stage A will read, and on a repo with open PRs
 * or collaborators, an unpinned read could pick up whatever a branch happens to
 * contain. Pinning costs nothing and removes the question.
 *
 * Forks and archived repos are skipped — a fork's description is someone else's
 * writing, and an archived repo is not a thing to pitch.
 */

const API = 'https://api.github.com';

/** README bytes handed to stage A. Enough for the opening pitch, not the whole doc. */
const README_BUDGET = 2_000;

interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  fork: boolean;
  archived: boolean;
  private: boolean;
  default_branch: string;
  language: string | null;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  pushed_at: string;
  created_at: string;
  homepage: string | null;
}

function headers(): Record<string, string> {
  const token = githubToken();
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'personal-pitcher-refresh',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Distinguishes "we ran out of quota" from "the API is broken".
 *
 * Worth its own error because the remedies are completely different: a rate
 * limit means set `GITHUB_TOKEN` or wait, while a 404 or a 500 means something
 * is actually wrong. Reported as one reason string, they look the same in the
 * run summary and the actionable one gets ignored.
 */
export class GitHubRateLimitError extends Error {
  constructor(resetAt: Date | null) {
    super(
      `GitHub rate limit exhausted${resetAt ? `, resets at ${resetAt.toISOString()}` : ''}. ` +
        'Set GITHUB_TOKEN to raise the limit from 60 to 5000 requests/hour.',
    );
    this.name = 'GitHubRateLimitError';
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: headers() });

  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if ((response.status === 403 || response.status === 429) && remaining === '0') {
      const reset = response.headers.get('x-ratelimit-reset');
      throw new GitHubRateLimitError(reset ? new Date(Number(reset) * 1000) : null);
    }
    throw new Error(`GitHub ${response.status} ${response.statusText} for ${url}`);
  }

  return (await response.json()) as T;
}

/**
 * First prose section of the README on the default branch.
 *
 * Badges, headings and HTML are dropped before the budget is applied, so the
 * 2 KB handed to the model is 2 KB of description rather than 2 KB of shield
 * images. Returns an empty string on any failure: a missing README is normal,
 * and a repo without one still has a description and a language.
 */
async function fetchReadme(repo: GitHubRepo): Promise<string> {
  const url = `${API}/repos/${repo.full_name}/readme?ref=${encodeURIComponent(repo.default_branch)}`;
  try {
    const payload = await getJson<{ content?: string; encoding?: string }>(url);
    if (!payload.content || payload.encoding !== 'base64') return '';

    const decoded = Buffer.from(payload.content, 'base64').toString('utf-8');

    return decoded
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, README_BUDGET);
  } catch (err) {
    // As in `fetchLanguages`: a spent budget affects every remaining call, so it
    // surfaces once with its remedy instead of nineteen times as an empty README.
    if (err instanceof GitHubRateLimitError) throw err;
    return '';
  }
}

/**
 * Full language breakdown, one extra request per repo.
 *
 * **Only fetched when a token is configured.** Unauthenticated GitHub allows 60
 * requests/hour, and this call is what decides whether a run costs ~2N requests
 * or ~N: with 19 repos that is 39 vs 20, so without a token one run fits in the
 * hourly budget and a second one inside the same hour does not. The list
 * response already carries `language` (the primary one), so the unauthenticated
 * path degrades to a shorter list rather than to nothing.
 *
 * A rate-limit error propagates rather than being swallowed — once the budget is
 * gone, every later call in the run will fail too, and failing fast with the
 * actionable message beats twenty silent empty results.
 */
async function fetchLanguages(repo: GitHubRepo): Promise<string[]> {
  if (!githubToken()) return repo.language ? [repo.language] : [];

  try {
    const payload = await getJson<Record<string, number>>(`${API}/repos/${repo.full_name}/languages`);
    return Object.entries(payload)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
      .slice(0, 6);
  } catch (err) {
    if (err instanceof GitHubRateLimitError) throw err;
    return repo.language ? [repo.language] : [];
  }
}

export async function fetchGitHub(): Promise<SourceFetch> {
  const user = githubUser();
  const repos = await getJson<GitHubRepo[]>(
    `${API}/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed&type=owner`,
  );

  const owned = repos.filter((repo) => !repo.fork && !repo.archived && !repo.private);

  // The list response above already carries `pushed_at` for every repo, so
  // deciding what to skip costs no extra request. A skipped repo then avoids two
  // API calls and, downstream, two model calls — which is where the real saving
  // is: the nightly run was spending ~25 minutes re-deriving descriptions for
  // projects nobody had touched. See `sourceState.ts`.
  const state = readSourceState('github');
  const upstreamByKey = new Map<string, string | null>();
  const skipped: string[] = [];

  const records: SourceRecord[] = [];

  for (const repo of owned) {
    upstreamByKey.set(repo.html_url, repo.pushed_at);

    if (canSkip(state, repo.html_url, repo.pushed_at)) {
      skipped.push(repo.html_url);
      continue;
    }

    const [readme, languages] = await Promise.all([fetchReadme(repo), fetchLanguages(repo)]);

    records.push({
      source: 'github',
      // The HTML URL, because that is what `projects.json` already stores as
      // `url` — matching on it means an entry Davit renamed by hand still
      // matches its repo instead of being proposed again as a new project.
      key: repo.html_url,
      facts: {
        name: repo.name,
        url: repo.html_url,
        defaultBranch: repo.default_branch,
        primaryLanguage: repo.language,
        languages,
        topics: repo.topics ?? [],
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        createdAt: repo.created_at,
        pushedAt: repo.pushed_at,
        homepage: repo.homepage,
      },
      untrusted: {
        description: repo.description ?? '',
        readme,
      },
    });
  }

  return {
    source: 'github',
    target: 'projects.json',
    records,
    summary: {
      user,
      publicRepos: owned.length,
      authenticated: Boolean(githubToken()),
      // Reported rather than silent: "19 records" dropping to "2 records" looks
      // like a broken adapter unless the run says why.
      skippedUnchanged: skipped.length,
      processed: records.length,
    },
    // Carried on the fetch so the orchestrator can record watermarks without
    // re-deriving which repos exist or when they were last pushed.
    itemState: { upstreamByKey, skippedKeys: new Set(skipped) },
    fetchedAt: new Date().toISOString(),
  };
}
