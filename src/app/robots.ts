import type { MetadataRoute } from 'next';

/**
 * Keeps the admin surface out of search results.
 *
 * This is hygiene, not security — `robots.txt` is a request, and publishing the
 * paths here arguably advertises them. It is still worth doing: the realistic
 * risk is not a crawler that ignores the file, it is a search for Davit's name
 * turning up a login box beside his portfolio. The password is what actually
 * guards the route (`src/lib/admin/auth.ts`).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/login', '/api/admin'],
    },
  };
}
