import fs from 'fs';
import path from 'path';
import type { ProfileContext } from '@/types';

/**
 * Reads one file out of `data/`.
 *
 * `loadProfileContext` names every file it loads, and that list must stay
 * explicit — no directory scan, and nothing from outside `data/`. Everything
 * returned here is concatenated into the prompt beside `SYSTEM_PROMPT` on every
 * visitor question, so a file that arrives in the context without someone
 * having decided it should is a file a visitor can be told the contents of.
 * Section 9 of the `verify` skill greps for the ways that goes wrong.
 */
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
  const siteRaw = JSON.parse(readDataFile('site.json'));

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
    // Listed as a labelled block so the model can answer "where can I hear his
    // music?" with every platform rather than whichever one it happened to see.
    musicLinks
      ? [
          'Where to listen:',
          musicLinks.spotify ? `- Spotify: ${musicLinks.spotify}` : '',
          musicLinks.appleMusic ? `- Apple Music: ${musicLinks.appleMusic}` : '',
          musicLinks.soundcloud ? `- SoundCloud: ${musicLinks.soundcloud}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  // This site, described for the model. Written as prose rather than dumped as
  // data because it is pasted straight into the prompt — see the note in
  // `.claude/skills/add-content-section`.
  const siteData = siteRaw.site ?? siteRaw;
  const chain = siteData.fallback_chain as Record<string, unknown> | undefined;
  const bullets = (items: unknown) =>
    Array.isArray(items) && items.length
      ? (items as string[]).map((i) => `- ${i}`).join('\n')
      : '';

  const assistant = siteData.assistant as Record<string, unknown> | undefined;

  const site = [
    `${siteData.name} — ${siteData.tagline}`,
    assistant?.name
      ? `The assistant: ${assistant.name} — ${assistant.expansion}. ${assistant.note ?? ''}`.trim()
      : '',
    siteData.summary ? `Summary: ${siteData.summary}` : '',
    siteData.url ? `Live at: ${siteData.url}` : '',
    siteData.repo ? `Source: ${siteData.repo}` : '',
    bullets(siteData.stack) ? `Stack:\n${bullets(siteData.stack)}` : '',
    bullets(siteData.how_answers_are_produced)
      ? `How an answer is produced:\n${bullets(siteData.how_answers_are_produced)}`
      : '',
    chain?.summary ? `Model fallback chain: ${chain.summary}` : '',
    bullets(chain?.tiers) ? `Tiers:\n${bullets(chain?.tiers)}` : '',
    bullets(chain?.design_notes) ? `Design notes:\n${bullets(chain?.design_notes)}` : '',
    bullets(siteData.guardrails) ? `Guardrails:\n${bullets(siteData.guardrails)}` : '',
    bullets(siteData.observability) ? `Observability:\n${bullets(siteData.observability)}` : '',
    siteData.why_it_exists ? `Why it exists: ${siteData.why_it_exists}` : '',
    // Restated inside the retrieved context, not only in the system prompt, so
    // the boundary travels with the content that invites the question.
    siteData.privacy_note
      ? `IMPORTANT — what must never be disclosed: ${siteData.privacy_note}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { bio, projects, community, hobbies, music: musicSections, site };
}
