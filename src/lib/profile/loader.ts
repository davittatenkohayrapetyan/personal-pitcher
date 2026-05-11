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

  const projects = projectsRaw
    .map((p: Record<string, unknown>) =>
      `Project: ${p.name}\nDescription: ${p.description}\nTech: ${(p.tech as string[]).join(', ')}\nHighlights: ${(p.highlights as string[]).join('; ')}`
    )
    .join('\n\n');

  const community = [
    'Talks:\n' + communityRaw.talks.map((t: Record<string, unknown>) => `- ${t.title} at ${t.event} (${t.year}): ${t.description}`).join('\n'),
    'Mentoring:\n' + communityRaw.mentoring.map((m: string) => `- ${m}`).join('\n'),
    'Open Source:\n' + communityRaw.openSource.map((o: string) => `- ${o}`).join('\n'),
    'Writing:\n' + communityRaw.writing.map((w: Record<string, unknown>) => `- ${w.title} on ${w.platform} (${w.year})`).join('\n'),
  ].join('\n\n');

  const hobbies = [
    'Hobbies:\n' + hobbiesRaw.hobbies.map((h: Record<string, unknown>) => `- ${h.name}: ${h.description}`).join('\n'),
    'Languages:\n' + hobbiesRaw.languages.map((l: Record<string, unknown>) => `- ${l.name}: ${l.level}`).join('\n'),
  ].join('\n\n');

  return { bio, projects, community, hobbies };
}
