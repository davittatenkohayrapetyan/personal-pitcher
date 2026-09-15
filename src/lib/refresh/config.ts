import path from 'path';
import type { SourceId } from './types';

/**
 * Environment parsing for the refresh job, in one place so the script and the
 * library never disagree about a default.
 */

const ALL_SOURCES: SourceId[] = ['github', 'spotify', 'appleMusic', 'soundcloud'];

export const DATA_DIR = path.resolve(process.cwd(), 'data');
export const SNAPSHOT_DIR = path.join(DATA_DIR, 'sources');
export const PROPOSAL_DIR = path.join(DATA_DIR, 'proposals');

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * Which adapters to run. A comma list rather than one flag per source, so
 * disabling an adapter that started failing is an env edit rather than a deploy.
 */
export function enabledSources(): SourceId[] {
  const raw = env('REFRESH_SOURCES');
  if (!raw) return ALL_SOURCES;
  const requested = raw.split(',').map((s) => s.trim());
  return ALL_SOURCES.filter((s) => requested.includes(s));
}

/**
 * Model for stage A (reading third-party text).
 *
 * Defaults to `MAC_OLLAMA_MODEL` on purpose. Naming a *different* model here
 * makes Ollama evict the resident one to load it, so the next visitor to the
 * live site pays a cold start of tens of seconds — a cost that shows up on the
 * website, not in this job's logs. Override only if the run is scheduled for an
 * hour when nobody is reading.
 */
export function extractModel(): string | undefined {
  return env('REFRESH_EXTRACT_MODEL');
}

/** Model for stage B (editing the profile). Same eviction caveat as above. */
export function editModel(): string | undefined {
  return env('REFRESH_EDIT_MODEL');
}

/**
 * Whether a run may fall back to OpenAI when the Mac is away.
 *
 * Defaults to false, which is the opposite of the answer path's policy and
 * deliberately so: the fallback chain exists so a *visitor* never waits on a
 * sleeping laptop. A batch job has no visitor. If the Mac isn't home the right
 * answer is to skip and run again tomorrow, not to bill a paid provider for a
 * background crawl nobody asked for.
 */
export function allowPaidFallback(): boolean {
  return env('REFRESH_ALLOW_PAID_FALLBACK') === 'true';
}

/** Generation timeout per model call. Longer than the answer path — nobody waits. */
export function refreshTimeoutMs(): number {
  const parsed = parseInt(env('REFRESH_TIMEOUT_MS') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 180_000;
}

export function githubUser(): string {
  return env('GITHUB_USER') ?? 'davittatenkohayrapetyan';
}

export function githubToken(): string | undefined {
  return env('GITHUB_TOKEN');
}

export function spotifyCredentials(): { id: string; secret: string } | null {
  const id = env('SPOTIFY_CLIENT_ID');
  const secret = env('SPOTIFY_CLIENT_SECRET');
  return id && secret ? { id, secret } : null;
}

/** Apple's numeric artist id, from the /artist/<slug>/<id> path of a Music URL. */
export function appleArtistId(): string {
  return env('APPLE_MUSIC_ARTIST_ID') ?? '1576499552';
}

export function spotifyArtistId(): string {
  return env('SPOTIFY_ARTIST_ID') ?? '4G26tr9xqGvtZa9B0qboob';
}

/** Accepts the `m.` mobile host; the adapter normalises it before calling oEmbed. */
export function soundcloudProfileUrl(): string {
  return env('SOUNDCLOUD_PROFILE_URL') ?? 'https://soundcloud.com/shepard-d';
}

/**
 * Optional. SoundCloud closed app registration years ago, so most setups will
 * not have one — without it the adapter still returns the profile via oEmbed,
 * just no track list.
 */
export function soundcloudClientId(): string | undefined {
  return env('SOUNDCLOUD_CLIENT_ID');
}

/**
 * Where the Pushover notification points for review.
 *
 * A notification whose only action is "go and find it yourself" is a
 * notification that gets postponed, and postponed review is the failure mode
 * this whole workflow is built to avoid.
 */
export function reviewUrl(): string {
  const base = (env('PUBLIC_BASE_URL') ?? 'https://davithayrapetyan.dev').replace(/\/+$/, '');
  return `${base}/admin`;
}
