/**
 * Shared literals that previously drifted between components.
 *
 * `LINKEDIN_URL` was typed out independently in `ProfileHero.tsx`,
 * `AppShell.tsx`, and (as of the question-quota feature) the `/api/ask`
 * route's final-answer CTA. One source of truth so a future profile update
 * can't update two of the three.
 */
export const LINKEDIN_URL = 'https://www.linkedin.com/in/davit-hayrapetyan-04377561/';
