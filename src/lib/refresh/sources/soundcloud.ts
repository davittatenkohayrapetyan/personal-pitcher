import type { SourceFetch, SourceRecord } from '../types';
import { soundcloudClientId, soundcloudProfileUrl } from '../config';

/**
 * SoundCloud adapter — feeds `data/music.json`.
 *
 * ## What is actually available, and what is not
 *
 * SoundCloud has an official API, but app registration has been closed to new
 * developers for years — there is no self-serve path to a client id. What is
 * open is **oEmbed**: a documented, keyless, public endpoint that returns the
 * profile's title, description, avatar and player embed. That is enough to
 * publish a verified SoundCloud presence on the profile. It is not enough for a
 * track list.
 *
 * The track list is therefore **opt-in**: set `SOUNDCLOUD_CLIENT_ID` if you have
 * one and this adapter also fetches tracks through the official API. Without it,
 * the adapter still succeeds and contributes the profile link and bio.
 *
 * ## Why not read the track list off the page
 *
 * The artist page embeds its own data in a `__sc_hydration` blob, and parsing it
 * would produce a full track list today with no credentials. It is also exactly
 * the scraping that this project declined to do for LinkedIn and Instagram, and
 * for the same reasons: it is against the platform's terms, it breaks whenever
 * they reshape their bundle, and the account it risks is Davit's own. Declining
 * it for the two hard platforms and then doing it for the easy one would make
 * the earlier reasoning a rationalisation rather than a rule.
 */

const OEMBED = 'https://soundcloud.com/oembed';
const API = 'https://api.soundcloud.com';

interface OEmbedResponse {
  title?: string;
  author_name?: string;
  author_url?: string;
  description?: string;
  thumbnail_url?: string;
  html?: string;
}

interface SoundCloudTrack {
  id: number;
  title: string;
  permalink_url: string;
  created_at: string;
  duration: number;
  genre?: string | null;
  playback_count?: number;
  description?: string | null;
}

/**
 * The mobile host (`m.soundcloud.com`) and the canonical one serve the same
 * profile, but oEmbed only resolves the canonical form. Normalised here so the
 * URL can be pasted from a phone — which is how it arrived.
 */
function canonicalProfileUrl(raw: string): string {
  return raw.replace(/^https?:\/\/(m|www)\.soundcloud\.com/, 'https://soundcloud.com').replace(/\/+$/, '');
}

async function fetchOEmbed(profileUrl: string): Promise<OEmbedResponse> {
  const url = `${OEMBED}?format=json&url=${encodeURIComponent(profileUrl)}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'personal-pitcher-refresh' } });
  if (!response.ok) {
    throw new Error(`SoundCloud oEmbed ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as OEmbedResponse;
}

/**
 * SoundCloud's numeric user id, which oEmbed exposes only inside the player
 * URL of the embed markup. Needed for the optional track fetch, and worth
 * recording either way: the permalink can be renamed, the id cannot.
 */
function userIdFromEmbed(html: string | undefined): number | null {
  const match = html?.match(/users(?:%2F|\/)(\d+)/);
  return match ? Number(match[1]) : null;
}

/** Official API, only reachable with a client id. Returns [] when unavailable. */
async function fetchTracks(userId: number, clientId: string): Promise<SoundCloudTrack[]> {
  const url = `${API}/users/${userId}/tracks?limit=200&client_id=${encodeURIComponent(clientId)}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'personal-pitcher-refresh' } });
  if (!response.ok) {
    throw new Error(`SoundCloud API ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as SoundCloudTrack[];
}

export async function fetchSoundCloud(): Promise<SourceFetch> {
  const profileUrl = canonicalProfileUrl(soundcloudProfileUrl());
  const oembed = await fetchOEmbed(profileUrl);
  const userId = userIdFromEmbed(oembed.html);
  const clientId = soundcloudClientId();

  const records: SourceRecord[] = [];
  let trackFetchError: string | null = null;

  if (userId !== null && clientId) {
    try {
      const tracks = await fetchTracks(userId, clientId);
      for (const track of tracks) {
        records.push({
          source: 'soundcloud',
          // Keyed on normalised title so a track released to both SoundCloud and
          // a streaming service collapses to one entry, as in the other adapters.
          key: track.title.trim().toLowerCase(),
          facts: {
            title: track.title.trim(),
            kind: 'single',
            year: new Date(track.created_at).getUTCFullYear(),
            releaseDate: track.created_at,
            url: track.permalink_url,
            soundcloudId: track.id,
            genre: track.genre ?? null,
            plays: track.playback_count ?? null,
          },
          // A track description is free text written on a third-party platform,
          // so it goes on the untrusted side even though it is Davit's own.
          untrusted: track.description ? { description: track.description } : {},
        });
      }
    } catch (err) {
      // A failed track fetch must not lose the profile link, which is the part
      // that works without credentials.
      trackFetchError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    source: 'soundcloud',
    target: 'music.json',
    records,
    summary: {
      profileUrl,
      displayName: oembed.author_name ?? oembed.title ?? null,
      avatarUrl: oembed.thumbnail_url ?? null,
      userId,
      trackListAvailable: Boolean(userId && clientId && !trackFetchError),
      // Stated rather than omitted so a reader of the snapshot can tell a
      // missing credential from a fetch that quietly failed.
      trackListUnavailableReason: !clientId
        ? 'SOUNDCLOUD_CLIENT_ID not set (registration is closed; oEmbed profile data only)'
        : userId === null
          ? 'user id not present in oEmbed embed markup'
          : trackFetchError,
      trackCount: records.length,
    },
    fetchedAt: new Date().toISOString(),
  };
}
