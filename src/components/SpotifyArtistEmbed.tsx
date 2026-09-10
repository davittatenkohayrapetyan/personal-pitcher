'use client';

interface SpotifyArtistEmbedProps {
  embedUrl: string;
  title: string;
}

/**
 * Lazy-loaded Spotify artist player. Sized to Spotify's standard embed
 * aspect; styled to match dialog surfaces.
 */
export default function SpotifyArtistEmbed({ embedUrl, title }: SpotifyArtistEmbedProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-black/40">
      <iframe
        src={embedUrl}
        title={title}
        width="100%"
        height={352}
        loading="lazy"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        className="block w-full"
      />
    </div>
  );
}
