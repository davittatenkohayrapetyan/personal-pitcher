'use client';

import { useState } from 'react';
import musicData from '../../../data/music.json';
import HighlightCard from '../HighlightCard';
import DetailsDialog from '../DetailsDialog';
import SpotifyArtistEmbed from '../SpotifyArtistEmbed';

interface Release {
  title: string;
  year: number;
  spotifyId: string | null;
  url: string | null;
  latest?: boolean;
}

const { music } = musicData;

/**
 * Streaming platforms, brand-tinted.
 *
 * Filtered on presence rather than hard-coded three deep: `music.json` is
 * written by the refresh job's review flow as well as by hand, so a link that
 * hasn't been filled in yet should drop out of the row rather than render as a
 * button to nowhere.
 */
const PLATFORMS = [
  {
    name: 'Spotify',
    href: music.links.spotify,
    className:
      'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30 hover:bg-emerald-500/25 hover:text-white',
  },
  {
    name: 'Apple Music',
    href: music.links.appleMusic,
    className:
      'bg-rose-500/15 text-rose-200 ring-rose-400/30 hover:bg-rose-500/25 hover:text-white',
  },
  {
    name: 'SoundCloud',
    href: music.links.soundcloud,
    className:
      'bg-orange-500/15 text-orange-200 ring-orange-400/30 hover:bg-orange-500/25 hover:text-white',
  },
].filter((platform): platform is { name: string; href: string; className: string } =>
  Boolean(platform.href),
);

const subtitleParts = [
  `${music.albums.length} album${music.albums.length === 1 ? '' : 's'}`,
  `${music.eps.length} EP${music.eps.length === 1 ? '' : 's'}`,
  `${music.singles.length} single${music.singles.length === 1 ? '' : 's'}`,
];

function ReleaseList({ heading, items }: { heading: string; items: Release[] }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby={`music-${heading.toLowerCase()}`}>
      <h3
        id={`music-${heading.toLowerCase()}`}
        className="mb-2 text-sm font-semibold text-white"
      >
        {heading}
      </h3>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {items.map((item) => {
          const label = `${item.title} · ${item.year}`;
          const inner = (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="font-medium text-white">{item.title}</span>
                <span className="ml-1.5 text-slate-400">· {item.year}</span>
              </span>
              {/* Kept outside the truncating span: on a narrow screen a long
                  title would otherwise clip the badge away entirely. */}
              <span className="flex flex-shrink-0 items-center gap-2">
                {item.latest && (
                  <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-200">
                    Latest
                  </span>
                )}
                {item.url && (
                  <svg
                    className="h-3 w-3 flex-shrink-0 text-slate-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                )}
              </span>
            </div>
          );
          return (
            <li key={`${item.title}-${item.year}`}>
              {item.url ? (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Listen to ${label} on Spotify`}
                  className="block rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300 transition-colors hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-white"
                >
                  {inner}
                </a>
              ) : (
                <div className="block rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300">
                  {inner}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function MusicCard() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <HighlightCard
        icon={<span aria-hidden="true">🎵</span>}
        title={`Music — ${music.alias}`}
        subtitle={subtitleParts.join(' · ')}
        description={`Electronic music producer since ${music.since} — emotional melodies, atmospheric textures, piano themes.`}
        badge="Shepard D"
        onClick={() => setOpen(true)}
      />
      <DetailsDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Music — ${music.alias}`}
        description={`Producing since ${music.since}. ${music.stats.monthlyListeners} monthly listeners · ${music.stats.followers} followers on Spotify.`}
      >
        <div className="space-y-6">
          <p className="text-sm leading-relaxed text-slate-300">{music.bio}</p>

          <section aria-labelledby="music-genres">
            <h3 id="music-genres" className="mb-2 text-sm font-semibold text-white">
              Genres & style
            </h3>
            <ul className="flex flex-wrap gap-2">
              {music.genres.map((genre) => (
                <li
                  key={genre}
                  className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-slate-300"
                >
                  {genre}
                </li>
              ))}
            </ul>
          </section>

          <SpotifyArtistEmbed
            embedUrl={music.links.spotifyEmbed}
            title={`${music.alias} on Spotify`}
          />

          <ReleaseList heading="Albums" items={music.albums as Release[]} />
          <ReleaseList heading="EPs" items={music.eps as Release[]} />
          <ReleaseList heading="Singles" items={music.singles as Release[]} />

          {music.playlists.length > 0 && (
            <section aria-labelledby="music-playlists">
              <h3 id="music-playlists" className="mb-2 text-sm font-semibold text-white">
                Featured playlists
              </h3>
              <ul className="space-y-2">
                {music.playlists.map((playlist) => (
                  <li key={playlist.title}>
                    <a
                      href={playlist.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300 transition-colors hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-white"
                    >
                      <span className="font-medium text-white">{playlist.title}</span>
                      <span className="ml-1.5 text-slate-400">· curated by {playlist.curator}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="music-platforms" className="pt-2">
            <h3 id="music-platforms" className="mb-2 text-sm font-semibold text-white">
              Where to listen
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {PLATFORMS.map((platform) => (
                <a
                  key={platform.name}
                  href={platform.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold ring-1 ring-inset transition-colors ${platform.className}`}
                >
                  {platform.name}
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </a>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Spotify stats as of {music.stats.asOf}
            </p>
          </section>
        </div>
      </DetailsDialog>
    </>
  );
}
