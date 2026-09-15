/**
 * The two HTTP facts every adapter shares.
 *
 * The User-Agent lived in `workday.ts` and `pinpoint.ts` as two identical
 * string literals until phase 2 added five more adapters. It is moved here
 * rather than copied a seventh time because of what it is: this is Davit's name
 * on the traffic, and §6 of `docs/job-outreach-plan.md` makes the honest,
 * contactable UA a requirement rather than a courtesy. Seven copies is seven
 * chances for one board to be told something different from the others, and the
 * one that drifts is the one nobody notices until a maintainer emails about it.
 *
 * It was tested rather than assumed against the endpoint most likely to refuse
 * it — Workday's, which sits behind Akamai bot management — and returns 200
 * with the same body a browser string does.
 */

export const USER_AGENT =
  'personal-pitcher-outreach/1.0 (+https://davithayrapetyan.dev; one person job search)';

/** Headers for a keyless JSON GET. `extra` is for the per-source additions. */
export function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...extra,
  };
}
