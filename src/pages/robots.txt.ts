import type { APIRoute } from 'astro';
import { includeDrafts } from '../lib/posts';

// The dev build (BLOG_INCLUDE_DRAFTS=1) disallows everything. This is the
// third layer of index protection behind Cloudflare Access and the
// X-Robots-Tag header set by Caddy.
// See .claude/project-infrastructure/08-environments.md
export const GET: APIRoute = ({ site }) => {
  const body = includeDrafts
    // Dev DOES allow crawling, deliberately. `Disallow: /` used to look like
    // the stronger choice, but it stops Google fetching the page at all — so
    // it never reads the `X-Robots-Tag: noindex` Caddy sets, and a dev URL
    // that someone links to can still be indexed as a bare listing. Letting
    // the crawler in is what makes the noindex effective. No Sitemap line
    // here: dev is never advertised. (2026-10-11)
    ? 'User-agent: *\nAllow: /\n'
    // The sitemap lives under the base path, not at the domain root.
    // `new URL('sitemap-index.xml', site)` drops /blog and 404s.
    : `User-agent: *\nAllow: /\n\nSitemap: ${new URL(`${import.meta.env.BASE_URL}/sitemap-index.xml`.replace(/\/{2,}/g, '/'), site)}\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
};
