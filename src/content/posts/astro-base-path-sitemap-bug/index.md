---
title: "Astro's docs gave me a robots.txt that 404s under a base path"
description: "new URL('sitemap-index.xml', site) drops the /blog base, because RFC 3986 says it must. The build passes, the sitemap is correct, and the one report that would tell you is documented not to look."
date: 2026-09-05
category: tech
tags: ["astro", "seo", "sitemap", "robots-txt", "cloudflare"]
draft: true
---

This blog lives at `cursedshrine.com/blog`. For a while, its `robots.txt`
told every crawler on the internet that the sitemap was here:

```
https://cursedshrine.com/sitemap-index.xml
```

That URL is a 404. It has always been a 404. It is not even served by
this blog — it belongs to a different process on the same machine.

The line that generated it came from Astro's own documentation.

## The recipe that ships the bug

Astro's sitemap integration docs have a section called "Sitemap link in
robots.txt". It offers a static template, and then it offers this, which
is the better-looking option because it reuses your config:

```ts
// src/pages/robots.txt.ts — from docs.astro.build, fetched 2026-09-05
import type { APIRoute } from 'astro';

const getRobotsTxt = (sitemapURL: URL) => `\
User-agent: *
Allow: /

Sitemap: ${sitemapURL.href}
`;

export const GET: APIRoute = ({ site }) => {
  const sitemapURL = new URL('sitemap-index.xml', site);
  return new Response(getRobotsTxt(sitemapURL));
};
```

I used it more or less verbatim. It is correct code. If your site is at
the root of a domain it does exactly what it says.

The word `base` does not appear anywhere on that page. Not in the prose,
not in the config examples, not in a warning. I checked the rendered
text: zero occurrences as a standalone word.

## `site` and `base` never meet

Here is the relevant part of this repo's `astro.config.mjs`, unchanged
since the day it went live:

```js
const site = process.env.BLOG_SITE ?? 'https://cursedshrine.com';

export default defineConfig({
  site,
  base: '/blog',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [mdx(), sitemap()],
```

Two separate keys. `site` is the origin. `base` is the path. The docs
say `@astrojs/sitemap` "needs to know your site's deployed URL", and the
value it means is `site` — which, by design, knows nothing about
`/blog`.

Everything downstream of that split has to join the two by hand. This is
the only place in the project where that join is written in application
code rather than done by the framework, and it is the only place that
was wrong.

## The URL API is correct, which is the problem

I want to be precise that nothing here is a bug in Node or in Astro.
Here is the resolution, run on this machine on 2026-09-05, Node
v24.13.0:

```
new URL('sitemap-index.xml', 'https://cursedshrine.com')      = https://cursedshrine.com/sitemap-index.xml
new URL('sitemap-index.xml', 'https://cursedshrine.com/blog') = https://cursedshrine.com/sitemap-index.xml
new URL('sitemap-index.xml', 'https://cursedshrine.com/blog/')= https://cursedshrine.com/blog/sitemap-index.xml
new URL('/blog/sitemap-index.xml', 'https://cursedshrine.com')= https://cursedshrine.com/blog/sitemap-index.xml
```

Line two is the one worth sitting with. That is the "fix" a lot of
people reach for first — put the base into `site` — and **it still
drops the base.** Only a trailing slash, or an absolute reference,
survives.

That behaviour is twenty-one years old and written down. RFC 3986
§5.2.3, verbatim:

> o  If the base URI has a defined authority component and an empty
>    path, then return a string consisting of "/" concatenated with the
>    reference's path; otherwise,
>
> o  return a string consisting of the reference's path component
>    appended to all but the last segment of the base URI's path (i.e.,
>    excluding any characters after the right-most "/" in the base URI
>    path...)

Both branches destroy `/blog`, by different routes. With
`https://cursedshrine.com` the path is empty, so branch one fires and
you get `/sitemap-index.xml`. With `https://cursedshrine.com/blog`, the
segment `blog` is "after the right-most `/`", so branch two discards it
and you get the same string. The WHATWG URL Standard that Node
implements behaves the same way.

So: the API did what it is specified to do, and the specification is not
going to change for me.

## The fix, and the trap inside the fix

Four tokens, in commit `b832a39`:

```diff
--- a/src/pages/robots.txt.ts
+++ b/src/pages/robots.txt.ts
@@ -8,6 +8,8 @@ import { includeDrafts } from '../lib/posts';
 export const GET: APIRoute = ({ site }) => {
   const body = includeDrafts
     ? 'User-agent: *\nDisallow: /\n'
-    : `User-agent: *\nAllow: /\n\nSitemap: ${new URL('sitemap-index.xml', site)}\n`;
+    // The sitemap lives under the base path, not at the domain root.
+    // `new URL('sitemap-index.xml', site)` drops /blog and 404s.
+    : `User-agent: *\nAllow: /\n\nSitemap: ${new URL(`${import.meta.env.BASE_URL}/sitemap-index.xml`.replace(/\/{2,}/g, '/'), site)}\n`;
   return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
 };
```

`import.meta.env.BASE_URL` is `/blog` here, so the reference becomes
`/blog/sitemap-index.xml` — absolute, path-rooted, immune to the merge
algorithm above.

The `.replace(/\/{2,}/g, '/')` is not tidiness. When no `base` is set,
Astro hands you `/`, and `'/' + '/sitemap-index.xml'` is
`//sitemap-index.xml`. That is a protocol-relative reference, and it
does not mean "two slashes":

```
new URL('//sitemap-index.xml', 'https://cursedshrine.com')
  = https://sitemap-index.xml/
```

The hostname is now `sitemap-index.xml`. A cosmetic-looking collapse is
the difference between pointing at your own site and pointing at a
domain you do not own.

## Four things that should have caught this

**The build.** It is string interpolation. There is nothing to throw.
`astro build` was green for the broken version and is green for the
fixed one.

**The sitemap generator.** This is the part that annoys me most, and it
is the reason the failure is so quiet: `@astrojs/sitemap` gets `base`
right. It always did. Here is what it emits today, fetched live:

```xml
<urlset ...><url><loc>https://cursedshrine.com/blog/</loc></url><url><loc>https://cursedshrine.com/blog/category/tech/</loc></url><url><loc>https://cursedshrine.com/blog/posts/hello-cursed-shrine/</loc></url><url><loc>https://cursedshrine.com/blog/search/</loc></url></urlset>
```

Every URL correct, every `/blog` present. The generated artifact was
never wrong. Only the hand-written pointer to it was. There is no
consistency check between those two things, because they are produced by
different code owned by different people.

**The 404 itself.** Requests to `https://cursedshrine.com/sitemap-index.xml`
never reach the blog. The tunnel routes `/blog` to the blog's server and
everything else to the apex site, so the 404 is generated somewhere else
entirely:

```
$ curl -sI http://localhost:4176/robots.txt
HTTP/1.0 404 File not found
Server: SimpleHTTP/0.6 Python/3.13.5
```

A Python `http.server` default error page. Nothing in the blog's logs
could ever have shown me this, because the request was never the blog's.

**Search Console.** This is the documented one, and it is the whole
"quietly" in the story. From Google's Sitemaps report help page:

> Important: This report shows only sitemaps that were submitted using
> this report or the API. It does not show any sitemaps discovered
> through a robots.txt reference or other discovery methods.

The report does have a `Couldn't fetch` status, and a wrong URL is
listed as a cause. But that status only exists for sitemaps you
submitted by hand. A sitemap advertised *only* through `robots.txt`, and
404ing, produces no error anywhere: not in the build, not in the report,
not in a Lighthouse run.

To be clear about what I am not claiming: I have no Search Console
property for this site and no screenshot of an empty report. What I am
quoting is the documented behaviour, which is enough for the argument
and is all I have.

## The corrected line still does not work

Fixing it felt good for about ten minutes, which is how long it took to
ask who actually reads `https://cursedshrine.com/blog/robots.txt`.

Nobody does. RFC 9309, the Robots Exclusion Protocol, Standards Track,
September 2022, §2.3:

> The rules MUST be accessible in a file named "/robots.txt" (all
> lowercase) in the top-level path of the service.

Google's own reference spells out the consequence in its table of
example locations:

> `https://example.com/folder/robots.txt` — Not a valid robots.txt file.
> Crawlers don't check for robots.txt files in subdirectories.

So a site under a subpath does not get to have a `robots.txt`. It can
serve the file; the file is simply not part of the protocol. Which means
the four-token fix produced a *correct* `Sitemap:` line in a document
that no crawler is specified to fetch.

Then it gets worse, and this part is checkable by anyone reading this.
Here is what the URL that crawlers *do* read returns today, 2026-09-05:

```
$ curl -sI https://cursedshrine.com/robots.txt
HTTP/2 200
content-type: text/plain; charset=utf-8
content-length: 1836
server: cloudflare

$ curl -s https://cursedshrine.com/robots.txt | grep -ci sitemap
0
```

Sixty-one lines, and not one of them is a `Sitemap:` line. The body is
Cloudflare's managed content — content-signal boilerplate, then a block
fenced by `# BEGIN Cloudflare Managed content` and
`# END Cloudflare Managed Content` allowing search engines and
disallowing a list of AI crawlers.

My origin does not serve that file at all:

```
$ curl -sI http://localhost:4176/robots.txt
HTTP/1.0 404 File not found
```

The origin 404s. The edge returns 200. Cloudflare is generating the
entire document. I have not gone digging in the dashboard to work out
exactly which setting produces it, so I am reporting what the wire
shows and nothing more.

Net position, today: `https://cursedshrine.com/blog/sitemap-index.xml`
returns a valid sitemap with every URL correct, and **nothing anywhere
advertises it.** The apex file has no `Sitemap:` line. The blog's file
is not read. The only remaining routes are submitting it directly in
Search Console, or getting a `Sitemap:` line into the origin file —
which, for a site under someone else's `/`, may not be yours to edit at
all. That is a constraint I had not thought about before this, and I
have not seen it written down anywhere.

## What I did not measure

I am not claiming this cost me anything. The fix was committed at
`07:59:54 IST` on 2026-09-02 and production went live at roughly 08:00
the same morning, so on the evidence the broken file may never have been
served to a crawler at all. I cannot prove that either way:
`/var/log/caddy/` on this box is empty, so there is no access log to
check. There is no traffic story here, no ranking story, and no
before-and-after graph. The honest stake is that a discovery channel was
dead and nothing would have told me.

## Versions, because a sitemap claim without one is useless

Everything above was checked on 2026-09-05 against:

```
astro              7.2.10
@astrojs/sitemap   3.7.4    (transitively, sitemap 9.0.1)
node               v24.13.0
```

Those are the exact versions in `package.json`, in `package-lock.json`,
and installed in `node_modules` — I checked all three, because they
disagree more often than people expect. If `@astrojs/sitemap` ever
starts emitting a `Sitemap:` line for you, or the docs page grows a
`base` warning, this post is stale and you should trust the docs.

One thing I could not settle: I searched the `withastro/astro` issue
tracker for reports of the base-drop specifically — sixteen hits for
`robots sitemap base`, five for `"robots.txt" base` — and none of them
describe it. The closest relevant issue is #5219, "@astro/sitemap does
not generate robots.txt", opened and closed as *not planned* on
2022-10-27. So generating the file stays the developer's problem, and
the guidance for doing it is the snippet at the top of this post. I am
not going to claim the interaction is undocumented anywhere in the
world; I will say I looked and did not find it.

## The general shape

This is not really about Astro. Anywhere a URL is assembled from two
config values that the framework keeps deliberately separate — Astro's
`site` and `base`, Next's `basePath`, Docusaurus's `baseUrl`, a GitHub
Pages project site — there is a join, the join is hand-written, and the
framework cannot check it because it never sees both halves in one
place.

**Look for the values your framework composes for you, and then find
the one place you compose them yourself.** That is where the bug is,
and it will not throw, because a wrong string is still a string.

The tell, in this case, was that the sitemap and the pointer to the
sitemap were generated by two different systems and never compared. If
you deploy under a subpath, go and fetch your own `Sitemap:` URL right
now. It takes eight seconds and the failure mode is silence.
