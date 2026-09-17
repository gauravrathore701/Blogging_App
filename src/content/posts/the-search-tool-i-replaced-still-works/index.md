---
title: "Pagefind works on my Raspberry Pi 5 after all. I kept my replacement anyway — here's the maths"
description: "Pagefind crashed on my Raspberry Pi 5, so I swapped in MiniSearch. Then I found an older Pagefind runs fine. Why I still didn't switch back, and when that decision expires."
date: 2026-09-06
updated: 2026-09-17
category: tech
tags: ["pagefind", "minisearch", "static-site", "astro", "raspberry-pi"]
draft: true
---

I wanted search on this blog, which runs on a Raspberry Pi 5. I picked Pagefind, and it crashed during the build with `<jemalloc>: Unsupported system page size` — the Pi 5's 16 KB memory pages versus an allocator that wasn't built for them. So I ripped it out, wrote a small MiniSearch setup instead, and started drafting a post saying Pagefind simply can't run on this hardware.

Then, before publishing that, I finally ran the one command I'd been putting off:

```
$ npx -y pagefind@1.4.0 --version
pagefind 1.4.0

$ npx -y pagefind@1.5.0 --version
pagefind 1.5.0

$ npx -y pagefind@1.5.2 --version
<jemalloc>: Unsupported system page size
<jemalloc>: Unsupported system page size
memory allocation of 16 bytes failed
```

Oh. Pagefind works on this Pi. Two releases of it, anyway.

## The tool I dumped was fine all along (sort of)

And 1.5.0 doesn't just start. Pointed at the built site on 2026-09-06, it indexed it:

```
$ npx -y pagefind@1.5.0 --site dist \
    --output-path /tmp/pf-test
[Building search indexes]
  Indexed 1 language
  Indexed 1 page
  Indexed 88 words
Finished in 0.445 seconds
```

`getconf PAGESIZE` on this Pi is still `16384`. The hardware didn't suddenly become compatible. Pagefind broke somewhere between 1.5.0 and 1.5.2 — there's no 1.5.1 on npm — and [issue #1147](https://github.com/Pagefind/pagefind/issues/1147) says exactly that. I'd read it, believed it, and never checked it myself.

I re-checked on 2026-09-17: 1.5.2 is still the newest release, it still crashes, and 1.5.0 still starts. (The full story of the crash is in [its own post](/blog/posts/jemalloc-unsupported-system-page-size-pi5/).)

So if you landed here from that error message: **you're probably not stuck.** Pin 1.5.0 and get on with your day. The rest of this post is about why I didn't.

## A pin that works is still a debt

A working pin isn't the same as a working dependency.

1.5.0 works *because* it's older than whatever broke. The version that runs is, by definition, the version from before the fix I'd be waiting for. That's an odd thing to build on. Every future release needs testing on this Pi before I can upgrade, and until someone fixes it upstream, the answer to "should I update?" is permanently "check first".

Pinning is borrowing, and this loan has no repayment date.

To be fair to the other side — and for most people the other side is obviously right: if Pagefind is the search on your site and 1.5.0 works, pin it. The pin costs you nothing today, a fix will probably come, and you keep a genuinely excellent tool. It just wasn't my call for a brand-new blog with two short posts on it, where a search box built for ten thousand pages was never the bottleneck.

## The other exits, with price tags

**Boot the 4 KB kernel.** Both kernels already ship on a Pi; it's one line in `config.txt` and a reboot. It also changes memory behaviour for every process on the machine to keep one build tool happy — on a headless Pi whose only network link is Wi-Fi. Not a gamble I wanted for a search box.

**Build the index on another machine.** Perfectly reasonable, and the right answer if you already have CI. But then the site can't be built start to finish on the machine that serves it, and I wanted to keep that.

**Change the tool.** What I did.

## What I built instead: one JSON file and a search box

MiniSearch 7.2.0 reading a JSON index that's generated at build time. The endpoint is 23 lines: walk the blog's posts, and for each one emit its `id`, `title`, `description`, `category`, `tags`, `date` and a cleaned-up `body`. The search page fetches that JSON and hands it to MiniSearch.

That really is all of it, and it's not the interesting part. The interesting part is what it costs as the blog grows.

## How big does the index get?

When I made this decision, the blog had two stub posts — 104 and 31 words. Real posts here run far longer, so I built a synthetic corpus out of this repo's own prose at 1,500 words per post and measured that. **Only the first row below was a real measurement at the time; the rest are estimates** from that synthetic corpus.

```
posts  raw JSON  gzip   +JS    on wire
1*       823 B   515 B  6.0K   ~6.5K
25       227 K    81 K  6.0K    ~87K
50       457 K   161 K  6.0K   ~167K
100      914 K   320 K  6.0K   ~326K
200      1.83M   639 K  6.0K   ~645K

* measured: 1 published post, 104 words.
  Rest estimated.
```

That works out to roughly 9.36 KB raw and 3.3 KB gzipped per 1,500-word post, growing in a straight line. A 3,000-word post roughly doubles its share; a 600-word one cuts it by more than half.

### The multiplication that makes you feel good

With two tiny posts, the tempting move is to multiply. Those two posts averaged about 594 bytes each in the index, and 594 bytes times 200 posts is 119 KB. That sounds completely fine — and it's wrong by more than an order of magnitude, because stub posts aren't real posts. The synthetic estimate for 200 real-length posts is about **1.83 MB raw**.

If you size a client-side search index from the posts you have today, and they're short because the blog is new, you'll get an answer that's wrong in exactly the direction that makes you feel good about it.

### Real posts, eleven days later

The blog has grown since, so here's the live index on 2026-09-17 instead of a guess:

```
site  posts  raw JSON   gzip -n
prod      9  99,231 B   37,315 B
```

(Published posts only, measured with `gzip -n` on 2026-09-17.)

The nine published posts average about 1,880 words of body text and about **11 KB raw / 4.1 KB gzipped each** — a bit heavier per post than the synthetic estimate, because the real posts are longer than 1,500 words. The search script adds about 6 KB gzipped on top.

### Where it stops being reasonable

These are judgement calls on the estimates above, not measurements:

- **Up to ~25 posts:** a non-issue. ~87 KB, once, on a page the reader chose to open. About one medium-sized photo.
- **~50 posts:** ~167 KB. Still defensible. This is where a careful person starts paying attention.
- **~100 posts: the line.** ~326 KB over the wire, and, by a rough proxy, about half a megabyte of index structure to build in the browser before the first keystroke does anything.
- **~200 posts:** ~645 KB gzipped for a search box. Indefensible. Something should have changed well before this.

### The comparison that stings

Pagefind's own homepage says it "can run a full-text search on a 10,000 page site with a total network payload under 300kB, including the Pagefind library itself." It splits its index into chunks and only fetches the ones a search needs. Mine ships the whole thing.

So by about 100 posts, my approach would be sending more bytes than Pagefind needs for a hundred times the content.

I'm aware of how that reads next to the decision above. It's the fair comparison, and leaving it out would make this a worse post.

## The expiry date, written down

Before measuring any of this, I'd written a revisit trigger into the project notes: *revisit when the index exceeds roughly 1 MB.*

At the synthetic 9.36 KB per post, 1 MB is about **107 posts**, close to the line above. With the real posts averaging about 11 KB each, the 1 MB mark comes a little sooner, at roughly 90 posts, if future posts are as long as these.

One caveat worth keeping: 1 MB *raw* is only about 350 KB *transferred*, because the server compresses and the reader's browser decompresses. Quoting the raw figure alone overstates the download and understates the memory.

When the trigger fires, in rough order of preference:

1. **Drop `body` from the index** and search titles, descriptions and tags only. On the synthetic corpus that shrinks 200 posts from about 1.83 MB raw to about 55 KB. The catch: search stops matching article text, which hurts on a tech blog where people search for error messages.
2. **Generate the index on a 4 KB-page machine** and commit the result.
3. **Pin Pagefind after all.** Which I now know is a real option, not wishful thinking.

## What I didn't measure

Being explicit, because a table like that invites over-reading:

- **No real-device timings.** The index-build times I have are Node on the Pi. No browser, no phone, no slow network. Nothing here says how fast search *feels* in someone's hand.
- **No brotli.** `brotli` isn't installed on this Pi, so every compressed number above is gzip. I'd assumed Cloudflare would serve brotli, but when I asked it for brotli or gzip on 2026-09-17, it sent the index back as gzip.
- **No real browser memory figure.** The "half a megabyte" is the byte length of MiniSearch's `toJSON()` output — a stand-in for the in-memory structure, not a measurement of what a browser actually allocates.

One small gotcha from measuring: plain `gzip -c file` stores the original file name in its header, so the same content compresses to slightly different sizes under different names. Use `gzip -n` when you're comparing.

## The short version

The best tool for this job runs on my Pi if I pin it one release back. I chose not to, because a pin that predates the fix you're waiting for is a debt with no due date, and because at this blog's size the difference is a few dozen kilobytes on one page.

I also wrote down the post count where that stops being true. It's about a hundred, give or take how long I keep writing.

---

*Checked on this Pi: Raspberry Pi 5, `getconf PAGESIZE` = 16384. The Pagefind version test and the 1.5.0 indexing run are from 2026-09-06; the version checks were repeated on 2026-09-17. MiniSearch 7.2.0 (still the latest on npm, 2026-09-17). The size table beyond the first row is an estimate from a synthetic corpus and is labelled as such; the live-index figures and the Pagefind homepage quote were checked on 2026-09-17.*
