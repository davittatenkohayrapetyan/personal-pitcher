import { loadProfileContext } from './profile/loader';
import type { Intent } from './classify';
import type { ProfileContext } from '@/types';

let cachedContext: ProfileContext | null = null;

function getContext(): ProfileContext {
  if (!cachedContext) {
    cachedContext = loadProfileContext();
  }
  return cachedContext;
}

export function retrieveContext(intent: Intent): string {
  const ctx = getContext();

  switch (intent) {
    case 'background':
      return ctx.bio;
    case 'projects':
      return `${ctx.bio}\n\n## Projects\n${ctx.projects}`;
    case 'community':
      return `${ctx.bio}\n\n## Community Work\n${ctx.community}`;
    case 'hobbies':
      return `${ctx.bio}\n\n## Personal Interests\n${ctx.hobbies}`;
    case 'contact':
      return ctx.bio;
    case 'general':
      return `${ctx.bio}\n\n## Projects\n${ctx.projects}\n\n## Community Work\n${ctx.community}\n\n## Personal Interests\n${ctx.hobbies}`;
    default:
      return ctx.bio;
  }
}
