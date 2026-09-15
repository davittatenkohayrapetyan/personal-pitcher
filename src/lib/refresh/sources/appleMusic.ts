import type { SourceFetch, SourceRecord } from '../types';
import { appleArtistId } from '../config';

/**
 * Apple Music adapter — feeds `data/music.json`.
 *
 * ## Why the iTunes Search API and not the Apple Music API
 *
 * The Apple Music API is the obvious choice and the wrong one here. It requires
 * a MusicKit private key from a paid Apple Developer Program membership, and
 * every request must carry a JWT signed with it — an annual fee and a key to
 * rotate, in exchange for catalog data about releases that are already public.
 *
 * The iTunes Search/Lookup API returns the same release list for a numeric
 * artist id with no key, no token and no account. It is the older and plainer
 * interface, and for "which records has this artist put out" it is complete.
 * Verified against artist 1576499552 (Shepard D): 31 releases, including some
 * that predate what `music.json` currently lists.
 *
 * The artist id is the trailing number in a Music URL:
 *   https://music.apple.com/us/artist/shepard-d/1576499552
 *                                              ^^^^^^^^^^
 *
 * ## Almost nothing here reaches a model
 *
 * A release has a title, a year and a URL. All three are facts read straight out
 * of the response, so the music records carry an empty `untrusted` block and
 * `index.ts` skips stage A for them entirely. Running a 26B model to retype a
 * release date would be theatre — the sanitiser still runs, because a title is a
 * string from a third-party server even when it is one of Davit's own.
 */

const LOOKUP = 'https://itunes.apple.com/lookup';

interface ITunesArtist {
  wrapperType: 'artist';
  artistId: number;
  artistName: string;
  artistLinkUrl: string;
  primaryGenreName?: string;
}

interface ITunesCollection {
  wrapperType: 'collection';
  collectionId: number;
  collectionName: string;
  collectionViewUrl: string;
  artistName: string;
  trackCount: number;
  releaseDate: string;
  primaryGenreName?: string;
  copyright?: string;
}

type ITunesResult = ITunesArtist | ITunesCollection;

/**
 * Apple appends " - Single" / " - EP" to collection names. Stripped for matching
 * against `music.json`, which stores the bare title and keeps the kind in the
 * array an entry lives in — but the raw name is kept as a fact so a reviewer can
 * see exactly what Apple returned.
 */
function bareTitle(name: string): string {
  return name.replace(/\s+-\s+(Single|EP)$/i, '').trim();
}

function releaseKind(collection: ITunesCollection): 'single' | 'ep' | 'album' {
  if (/\s+-\s+EP$/i.test(collection.collectionName)) return 'ep';
  if (/\s+-\s+Single$/i.test(collection.collectionName) || collection.trackCount === 1) {
    return 'single';
  }
  return 'album';
}

export async function fetchAppleMusic(): Promise<SourceFetch> {
  const artistId = appleArtistId();
  const url = `${LOOKUP}?id=${encodeURIComponent(artistId)}&entity=album&limit=200&country=us`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'personal-pitcher-refresh' },
  });
  if (!response.ok) {
    throw new Error(`iTunes ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { resultCount: number; results: ITunesResult[] };
  const artist = payload.results.find((r): r is ITunesArtist => r.wrapperType === 'artist');
  const collections = payload.results.filter(
    (r): r is ITunesCollection => r.wrapperType === 'collection',
  );

  const records: SourceRecord[] = collections.map((collection) => ({
    source: 'appleMusic',
    // Keyed on the normalised title rather than Apple's numeric id, because
    // `music.json` is organised by title and the same release carries different
    // ids on Apple and Spotify. Title is what lets the two sources agree.
    key: bareTitle(collection.collectionName).toLowerCase(),
    facts: {
      title: bareTitle(collection.collectionName),
      appleName: collection.collectionName,
      kind: releaseKind(collection),
      year: new Date(collection.releaseDate).getUTCFullYear(),
      releaseDate: collection.releaseDate,
      trackCount: collection.trackCount,
      appleId: collection.collectionId,
      // `?uo=4` is an affiliate-tracking parameter iTunes appends. Stripped so
      // the profile does not publish a tracking link nobody chose to add.
      url: collection.collectionViewUrl.replace(/\?uo=\d+$/, ''),
      genre: collection.primaryGenreName ?? null,
    },
    // A release has no prose. Nothing here needs a model — see the file header.
    untrusted: {},
  }));

  return {
    source: 'appleMusic',
    target: 'music.json',
    records,
    summary: {
      artistId,
      artistName: artist?.artistName ?? null,
      artistUrl: artist?.artistLinkUrl.replace(/\?uo=\d+$/, '') ?? null,
      primaryGenre: artist?.primaryGenreName ?? null,
      releaseCount: records.length,
    },
    fetchedAt: new Date().toISOString(),
  };
}
