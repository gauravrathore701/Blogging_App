---
title: "I copied Astro's robots.txt recipe and it pointed my sitemap at a 404"
description: "Under a /blog base path, new URL('sitemap-index.xml', site) quietly drops /blog. The build passes, the sitemap is fine, and nothing warns you. Then it turned out crawlers never read the fixed file."
date: 2026-09-05
category: tech
tags: ["astro", "seo", "sitemap", "robots-txt", "cloudflare"]
draft: true
---

This blog runs on a Raspberry Pi and lives at `cursedshrine.com/blog`. The first version of its `robots.txt` would have sent search engines looking for my sitemap at `https://cursedshrine.com/sitemap-index.xml`. That address is a 404. It has always been a 404. It isn't even served by the blog — it belongs to a different site on the same machine. The build was green, the sitemap itself was perfect, and nothing anywhere complained. The line that caused it came straight out of Astro's own documentation.

This is the story of a one-line bug, a twenty-one-year-old rule that guarantees it, and the slightly embarrassing discovery that my fix pointed at a file no crawler reads.

## The recipe that ships the bug

Astro's sitemap docs have a section called "Sitemap link in robots.txt". It offers a plain static file, and then it offers this — the nicer-looking option, because it reuses your config:

```ts
// src/pages/robots.txt.ts — from docs.astro.build
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

I used it more or less as written. And to be fair to it, it's correct code: if your site sits at the root of a domain, it does exactly what it promises.

The word `base` doesn't appear anywhere on that page. Not in the text, not in a config example, not in a warning. I checked the rendered page on 2026-09-05 and again on 2026-09-17: zero times as a standalone word, and the snippet is unchanged.

## `site` and `base` never meet

Here's the relevant bit of this blog's `astro.config.mjs`:

```js
const site = process.env.BLOG_SITE
  ?? 'https://cursedshrine.com';

export default defineConfig({
  site,
  base: '/blog',
  ...
```

Two separate settings. `site` is the domain. `base` is the folder. The sitemap docs say the integration "needs to know your site's deployed URL", and the value they mean is `site` — which, by design, knows nothing about `/blog`.

So anything that needs the full address has to glue those two together by hand. In this project, that glue is written in exactly one place in my own code rather than by the framework. It was also the only place that was wrong. Funny how that works.

## The URL API did exactly what it's told

Nothing here is a bug in Node or in Astro, and that's the annoying part. Here's how `new URL()` resolves these, run on this Pi with Node v24.13.0:

```
new URL('sitemap-index.xml',
        'https://cursedshrine.com')
  → https://cursedshrine.com/sitemap-index.xml

new URL('sitemap-index.xml',
        'https://cursedshrine.com/blog')
  → https://cursedshrine.com/sitemap-index.xml

new URL('sitemap-index.xml',
        'https://cursedshrine.com/blog/')
  → https://cursedshrine.com/blog/sitemap-index.xml

new URL('/blog/sitemap-index.xml',
        'https://cursedshrine.com')
  → https://cursedshrine.com/blog/sitemap-index.xml
```

The second one deserves a moment. That's the "fix" most people try first — just put `/blog` into `site` — and **it still throws `/blog` away.** Only a trailing slash, or a path that starts with `/`, survives.

That behaviour is older than most JavaScript frameworks, and it's written down. RFC 3986 §5.2.3, word for word:

> o  If the base URI has a defined authority component and an empty
>    path, then return a string consisting of "/" concatenated with the
>    reference's path; otherwise,
>
> o  return a string consisting of the reference's path component
>    appended to all but the last segment of the base URI's path (i.e.,
>    excluding any characters after the right-most "/" in the base URI
>    path...)

Both branches eat `/blog`, just by different routes. With `https://cursedshrine.com` the path is empty, so the first rule fires and you get `/sitemap-index.xml`. With `https://cursedshrine.com/blog`, the word `blog` comes after the last `/`, so the second rule drops it and you land in exactly the same place. The WHATWG URL Standard that Node follows behaves the same way.

The API did what the spec says. The spec isn't going to change for my blog.

## Why nothing noticed

This is the part that bugs me. Four things could have caught it, and none of them did.

**The build.** It's string interpolation. There's nothing to throw. `astro build` was green with the broken line and green with the fixed one.

**The sitemap generator.** `@astrojs/sitemap` gets `base` right. It always did. Here's the start of what it serves today, fetched live on 2026-09-17:

```
<url><loc>
  https://cursedshrine.com/blog/
</loc>...</url>
<url><loc>
  https://cursedshrine.com/blog/category/tech/
</loc>...</url>
```

All 11 URLs in it include `/blog`. The sitemap was never wrong — only my hand-written pointer to it was. And nothing compares those two, because they're produced by different code written by different people.

**The 404 itself.** Requests for `/sitemap-index.xml` at the root never reach the blog. The tunnel sends `/blog` to the blog's server and everything else to the main site, so the 404 comes from somewhere else entirely:

```
$ curl -sI \
  http://localhost:4176/sitemap-index.xml
HTTP/1.0 404 File not found
Server: SimpleHTTP/0.6 Python/3.13.5
```

That's the main site's little Python server saying no. Nothing in the blog's logs could ever have shown me this, because the request was never the blog's.

**Search Console.** This is the one that's documented. From Google's help page for the Sitemaps report:

> Important: This report shows only sitemaps that were submitted using
> this report or the API. It does not show any sitemaps discovered
> through a robots.txt reference or other discovery methods.

The report does have a `Couldn't fetch` status, and a wrong URL is listed as a cause. But that only covers sitemaps you submitted by hand. A sitemap advertised *only* through `robots.txt` that 404s produces no error anywhere: not in the build and not in the report.

I have no Search Console property for this site, so this is the documented behaviour, not a screenshot of mine.

And nobody had reported it either, as far as I could find. On 2026-09-05 I searched the `withastro/astro` issue tracker for this exact problem — sixteen results for `robots sitemap base`, five for `"robots.txt" base` — and none of them describe it. The closest is #5219, "@astro/sitemap does not generate robots.txt", closed as *not planned* on 2022-10-27. So writing that file stays your job, and the guidance for it is the snippet at the top of this post.

## The fix, and the trap hiding inside it

The change went in as commit `b832a39` (wrapped and trimmed here so it fits a phone screen; in the real file each side is a single line):

```diff
-  : `...Sitemap: ${new URL(
-      'sitemap-index.xml', site)}\n`;
+  // The sitemap lives under the base path,
+  // not at the domain root.
+  : `...Sitemap: ${new URL(
+      `${import.meta.env.BASE_URL}/sitemap-index.xml`
+        .replace(/\/{2,}/g, '/'),
+      site)}\n`;
```

`import.meta.env.BASE_URL` is `/blog` here, so the path becomes `/blog/sitemap-index.xml` — it starts with a slash, so the merge rules above can't touch it.

That `.replace(/\/{2,}/g, '/')` isn't there to look tidy. When no `base` is set, Astro gives you `/`, and `'/' + '/sitemap-index.xml'` is `//sitemap-index.xml`. That doesn't mean "two slashes". It means "a different website":

```
new URL('//sitemap-index.xml',
        'https://cursedshrine.com')
  → https://sitemap-index.xml/
```

The hostname is now `sitemap-index.xml`. One harmless-looking regex is the difference between pointing at your own site and pointing at a domain you don't own.

## Plot twist: nobody reads that file

Fixing it felt great, right up until I asked who actually reads `https://cursedshrine.com/blog/robots.txt`.

Nobody does. RFC 9309, the Robots Exclusion Protocol, §2.3:

> The rules MUST be accessible in a file named "/robots.txt" (all
> lowercase) in the top-level path of the service.

Google's own reference spells out what that means, in its table of example locations:

> `https://example.com/folder/robots.txt` — Not a valid robots.txt file.
> Crawlers don't check for robots.txt files in subdirectories.

So a site living in a folder doesn't really get a `robots.txt`. It can serve one, but the file isn't part of the protocol. My fix produced a perfectly correct `Sitemap:` line in a document no crawler is supposed to fetch.

And it got better. On 2026-09-05, here's what the file crawlers *do* read looked like:

```
$ curl -sI https://cursedshrine.com/robots.txt
HTTP/2 200
content-length: 1836
server: cloudflare

$ curl -s https://cursedshrine.com/robots.txt \
  | grep -ci sitemap
0
```

Sixty-one lines, and not a single `Sitemap:` line. It was Cloudflare's managed content — a block about search engines and AI crawlers — because the main site's own server didn't have a `robots.txt` at all and returned a 404. Cloudflare was making up the whole file.

So on that day, the sitemap at `cursedshrine.com/blog/sitemap-index.xml` was valid, every URL was correct, and **nothing anywhere pointed to it.** A site in someone else's folder can't fix that from inside the folder. The fix has to happen one level up.

## What actually fixed it

The real fix was a `robots.txt` at the top of the domain, served by the main site's own server instead of Cloudflare's stand-in. It went live on 2026-09-06 at 12:26:20 IST (I wrote about that day in [three-quarters of my traffic was a 404](/blog/posts/three-quarters-of-my-traffic-was-a-404/)). Here's what crawlers get today, 2026-09-17:

```
$ curl -s https://cursedshrine.com/robots.txt
User-agent: *
Allow: /
...
Disallow: /cdn-cgi/

Sitemap: https://cursedshrine.com/sitemap.xml
Sitemap: https://cursedshrine.com/blog/
         sitemap-index.xml
```

(The last line is wrapped here to fit your screen; in the file it's one line.)

The version on Cloudflare's edge matches the file on the Pi byte for byte. Both sitemaps it lists return 200, and the blog's one is finally advertised in the one place crawlers are told to look.

The blog still serves its own `/blog/robots.txt` with the corrected line. It's harmless and costs nothing, but it's the top-level file doing the actual work.

## What I didn't measure

I'm not claiming this cost me anything. The in-blog fix was committed at 07:59:54 IST on 2026-09-02, and production went live around 08:00 that same morning, so the broken line may never have been served to a crawler at all. I can't prove that either way: `/var/log/caddy/` on this Pi is empty, so there's no access log to check.

There's no traffic story here, no ranking drama, no before-and-after graph. The honest stakes are smaller: a way for search engines to find the blog was dead, and nothing would have told me.

## Versions, because a sitemap claim without them is useless

Checked on 2026-09-17 against what's in `package.json`, `package-lock.json` and `node_modules`:

```
astro              7.2.10
@astrojs/sitemap   3.7.4
  (sitemap         9.0.1)
node               v24.13.0
```

If `@astrojs/sitemap` ever starts writing a `Sitemap:` line for you, or the docs page grows a `base` warning, this post is out of date and you should trust the docs.

## Go check yours

This isn't really about Astro. Anywhere a URL is built from two settings your framework deliberately keeps apart — Astro's `site` and `base`, Next's `basePath`, Docusaurus's `baseUrl`, a GitHub Pages project site — there's a join. The join is hand-written, and the framework can't check it because it never sees both halves in one place.

**Find the values your framework puts together for you, then find the one spot where you put them together yourself.** That's where the bug is, and it won't throw, because a wrong string is still a string.

If your site lives in a subfolder, do two things right now: fetch your own `Sitemap:` URL, and then fetch the `robots.txt` at the very top of your domain to see whether it mentions your sitemap at all. It takes about eight seconds, and the way this fails is silence.

---

*Observed on this Pi: Astro 7.2.10, `@astrojs/sitemap` 3.7.4, Node v24.13.0. URL resolution re-run and the Astro docs page re-checked on 2026-09-17. The Cloudflare-managed apex `robots.txt` (1836 bytes, no `Sitemap:` line) was captured on 2026-09-05; the origin `robots.txt` went live on 2026-09-06 12:26:20 IST and was re-fetched on 2026-09-17. No crawler access logs exist for the period the broken line could have been live.*
