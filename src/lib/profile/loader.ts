import fs from 'fs';
import path from 'path';
import type { ProfileContext } from '@/types';

function readDataFile(filename: string): string {
  const filePath = path.join(process.cwd(), 'data', filename);
  return fs.readFileSync(filePath, 'utf-8');
}

export function loadProfileContext(): ProfileContext {
  const bio = readDataFile('profile.md');
  const projectsRaw = JSON.parse(readDataFile('projects.json'));
  const communityRaw = JSON.parse(readDataFile('community.json'));
  const hobbiesRaw = JSON.parse(readDataFile('hobbies.json'));
  const musicRaw = JSON.parse(readDataFile('music.json'));

  const projectsList: Record<string, unknown>[] = projectsRaw.projects ?? projectsRaw;
  const projects = projectsList
    .map((p: Record<string, unknown>) =>
      `Project: ${p.name}\nDescription: ${p.description}\nTech: ${(p.tech as string[]).join(', ')}\nHighlights: ${(p.highlights as string[]).join('; ')}`
    )
    .join('\n\n');

  const communityData = communityRaw.community ?? communityRaw;

  const orgLines = (communityData.organizations ?? [])
    .map((o: Record<string, unknown>) => `- ${o.role} at ${o.name} (since ${o.since}): ${o.description}`)
    .join('\n');

  const eventLines = (communityData.events ?? [])
    .map((e: Record<string, unknown>) => `- ${e.name} (${e.date ?? 'TBD'}), Role: ${e.role}${e.attendees ? `, Attendees: ${e.attendees}` : ''}: ${e.description}`)
    .join('\n');

  const speakingLines = (communityData.speaking_and_mentoring ?? [])
    .map((s: Record<string, unknown>) => `- ${s.type} at ${s.organization}: ${s.description}`)
    .join('\n');

  const strengthLines = (communityData.community_strengths ?? [])
    .map((s: string) => `- ${s}`)
    .join('\n');

  const community = [
    communityData.positioning_summary ? `Summary: ${communityData.positioning_summary}` : '',
    orgLines ? `Organizations:\n${orgLines}` : '',
    eventLines ? `Events Organized:\n${eventLines}` : '',
    speakingLines ? `Speaking & Mentoring:\n${speakingLines}` : '',
    strengthLines ? `Community Strengths:\n${strengthLines}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const hobbies = [
    'Hobbies:\n' + hobbiesRaw.hobbies.map((h: Record<string, unknown>) => `- ${h.name}: ${h.description}`).join('\n'),
    'Languages:\n' + hobbiesRaw.languages.map((l: Record<string, unknown>) => `- ${l.name}: ${l.level}`).join('\n'),
  ].join('\n\n');

  const musicData = musicRaw.music ?? musicRaw;
  const formatRelease = (r: Record<string, unknown>) =>
    `- ${r.title} (${r.year})${r.url ? ` — ${r.url}` : ''}`;

  const musicStats = musicData.stats as Record<string, unknown> | undefined;
  const musicLinks = musicData.links as Record<string, unknown> | undefined;
  const musicSections = [
    `Music career as ${musicData.alias} (electronic music producer, since ${musicData.since}).`,
    `Bio: ${musicData.bio}`,
    Array.isArray(musicData.genres) && musicData.genres.length
      ? `Genres: ${(musicData.genres as string[]).join(', ')}`
      : '',
    musicStats
      ? `Spotify stats (${musicStats.asOf}): ${musicStats.monthlyListeners} monthly listeners, ${musicStats.followers} followers.`
      : '',
    Array.isArray(musicData.albums) && musicData.albums.length
      ? `Albums:\n${(musicData.albums as Record<string, unknown>[]).map(formatRelease).join('\n')}`
      : '',
    Array.isArray(musicData.eps) && musicData.eps.length
      ? `EPs:\n${(musicData.eps as Record<string, unknown>[]).map(formatRelease).join('\n')}`
      : '',
    Array.isArray(musicData.singles) && musicData.singles.length
      ? `Singles:\n${(musicData.singles as Record<string, unknown>[]).map(formatRelease).join('\n')}`
      : '',
    Array.isArray(musicData.playlists) && musicData.playlists.length
      ? `Playlists:\n${(musicData.playlists as Record<string, unknown>[])
          .map((p) => `- ${p.title} (curated by ${p.curator})${p.url ? ` — ${p.url}` : ''}`)
          .join('\n')}`
      : '',
    musicLinks?.spotify ? `Spotify artist URL: ${musicLinks.spotify}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { bio, projects, community, hobbies, music: musicSections };
}
