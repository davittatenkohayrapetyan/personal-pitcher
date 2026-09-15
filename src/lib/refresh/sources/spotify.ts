import type { SourceFetch, SourceRecord } from '../types';
import { spotifyArtistId, spotifyCredentials } from '../config';

/**
 * Spotify adapter — feeds `data/music.json`.
 *
 * Uses the Client Credentials flow: an app-level token, no user login, no
 * refresh dance, no scopes. That is enough because everything wanted here is
 * public catalog data about a public artist. It does mean follower counts are
 * available but **monthly listeners are not** — that figure appears only in the
 * artist-facing Spotify for Artists product and has no Web API endpoint.
 * `music.json` records it as a hand-entered stat with an `asOf` date, and this
 * adapter deliberately leaves it alone rather than proposing a stale number.
 *
 * Credentials come from a free app registered at developer.spotify.com. Without
 * them the adapter reports `not_configured` and the run carries on — Apple Music
 * needs no key at all, so the music section still refreshes.
 */

const ACCOUNTS = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

interface SpotifyAlbum {
  id: string;
  name: string;
  album_type: 'album' | 'single' | 'compilation';
  album_group?: string;
  release_date: string;
  total_tracks: number;
  external_urls: { spotify: string };
}

interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  followers: { total: number };
  popularity: number;
  external_urls: { spotify: string };
}

export class SpotifyNotConfiguredError extends Error {
  constructor() {
    super('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set');
    this.name = 'SpotifyNotConfiguredError';
  }
}

async function getToken(): Promise<string> {
  const credentials = spotifyCredentials();
  if (!credentials) throw new SpotifyNotConfiguredError();

  const response = await fetch(ACCOUNTS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(`Spotify token ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error('Spotify returned no access token');
  return payload.access_token;
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Spotify ${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as T;
}

/** Spotify's `release_date` is `YYYY`, `YYYY-MM` or `YYYY-MM-DD` depending on precision. */
function releaseYear(releaseDate: string): number {
  return parseInt(releaseDate.slice(0, 4), 10);
}

export async function fetchSpotify(): Promise<SourceFetch> {
  const artistId = spotifyArtistId();
  const token = await getToken();

  const artist = await getJson<SpotifyArtist>(`${API}/artists/${artistId}`, token);

  const albums: SpotifyAlbum[] = [];
  let next: string | null =
    `${API}/artists/${artistId}/albums?include_groups=album,single&limit=50&market=US`;

  while (next) {
    const page: { items: SpotifyAlbum[]; next: string | null } = await getJson(next, token);
    albums.push(...page.items);
    next = page.next;
  }

  // Spotify returns the same release once per market/reissue. Keyed by title so
  // duplicates collapse the same way they do in the Apple adapter, keeping the
  // earliest date — a re-release should not make a 2021 track look like new work.
  const byTitle = new Map<string, SpotifyAlbum>();
  for (const album of albums) {
    const key = album.name.trim().toLowerCase();
    const existing = byTitle.get(key);
    if (!existing || album.release_date < existing.release_date) {
      byTitle.set(key, album);
    }
  }

  const records: SourceRecord[] = [...byTitle.entries()].map(([key, album]) => ({
    source: 'spotify',
    key,
    facts: {
      title: album.name.trim(),
      kind: album.album_type === 'album' ? 'album' : 'single',
      year: releaseYear(album.release_date),
      releaseDate: album.release_date,
      trackCount: album.total_tracks,
      spotifyId: album.id,
      url: album.external_urls.spotify,
    },
    untrusted: {},
  }));

  return {
    source: 'spotify',
    target: 'music.json',
    records,
    summary: {
      artistId,
      artistName: artist.name,
      followers: artist.followers.total,
      popularity: artist.popularity,
      genres: artist.genres,
      url: artist.external_urls.spotify,
      // Stated rather than omitted, so a reader of the snapshot knows the gap is
      // an API limitation and not a fetch that quietly failed.
      monthlyListeners: null,
    },
    fetchedAt: new Date().toISOString(),
  };
}
