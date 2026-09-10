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
                {item.latest && (
                  <span className="ml-2 rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-200">
                    Latest
                  </span>
                )}
              </span>
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

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <a
              href={music.links.spotify}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-200 ring-1 ring-inset ring-emerald-400/30 transition-colors hover:bg-emerald-500/25 hover:text-white"
            >
              Listen on Spotify
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </a>
            <span className="text-xs text-slate-500">
              Spotify stats as of {music.stats.asOf}
            </span>
          </div>
        </div>
      </DetailsDialog>
    </>
  );
}
