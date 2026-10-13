// The public home of every page, regardless of which host is serving this
// build. Dev renders the same pages at dev.cursedshrine.com; canonical URLs
// and structured data still point here, so a crawled dev page consolidates
// into the real one instead of competing with it. Drafts are excluded by
// their callers — they have no production URL. (2026-10-11)
export const PROD_SITE = 'https://cursedshrine.com';

/** Absolute production URL for a path that already carries the /blog base. */
export function prodUrl(pathname: string): URL {
  return new URL(pathname.replace(/\/{2,}/g, '/'), PROD_SITE);
}
