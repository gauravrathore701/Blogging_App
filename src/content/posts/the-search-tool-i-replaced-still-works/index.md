---
title: "The search tool I replaced still works. I checked."
description: "Pagefind aborts on a Raspberry Pi 5 — but only from 1.5.2. 1.5.0 indexes fine. So this was never 'the tool cannot run here'. It was a pin I declined, and here is the arithmetic."
date: 2026-09-06
category: tech
tags: ["pagefind", "minisearch", "static-site", "astro", "raspberry-pi"]
draft: true
---

I picked Pagefind for this blog's search, watched it die three seconds
into a build, and replaced it with MiniSearch. Then I wrote a post
explaining that the Raspberry Pi's 16 KB memory pages made Pagefind
unusable here.

Before publishing that, I finally ran the one command I had been
putting off.

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

Pagefind works on this machine. Two releases of it, anyway.

And 1.5.0 does not merely start. Pointed at a built site:

```
$ npx -y pagefind@1.5.0 --site dist \
    --output-path /tmp/pf-test
[Building search indexes]
  Indexed 1 language
  Indexed 1 page
  Indexed 88 words
Finished in 0.445 seconds
```

`getconf PAGESIZE` on this box is `16384`, unchanged. The hardware did
not become compatible. The tool regressed between 1.5.0 and 1.5.2, and
[issue #1147](https://github.com/Pagefind/pagefind/issues/1147) says so
in exactly those terms — I had read it, believed it, and never
confirmed it.

So if you arrived here from that error message: **you are probably not
stuck.** Pin 1.5.0 and get on with your day. The rest of this is about
why I did not.

## Why I did not pin

A working pin is not the same thing as a working dependency.

1.5.0 works precisely because it predates whatever landed in 1.5.1. The
version that runs is, by construction, the version before the change I
am waiting for someone to fix. That is a strange thing to build on. It
means every future release needs re-testing against an allocator bug on
an architecture the project does not appear to test on, and until then
the answer to "should I upgrade?" is permanently "check first".

Pinning is debt, and this particular pin has no repayment date attached
to it.

I want to be fair to the other side, because for most people the other
side is obviously right: if Pagefind is the search on your site and it
works at 1.5.0, pin it and move on. You will get a fix eventually, the
pin costs you nothing in the meantime, and you keep a genuinely
excellent tool. I am not going to pretend that is the wrong call. It
just was not mine, for a blog with two posts on it and no urgent need
for a search box that scales to ten thousand pages.

## The other options, priced

**Boot the 4 KB kernel.** Both kernels already ship on a Pi; it is one
line in `config.txt` and a reboot. It also changes the memory model for
every process on the machine to satisfy one build-time dependency, on a
box that sits in another room and whose only uplink is Wi-Fi. The
mechanism is [its own post](/blog/posts/jemalloc-unsupported-system-page-size-pi5/).

**Build the index somewhere else.** Perfectly reasonable, and the right
answer if you already have CI. It means the site can no longer be built
end-to-end on the machine that serves it, which was a property I wanted
to keep.

**Change the tool.** What I did.

## What I built instead

MiniSearch 7.2.0 over a JSON index generated at build time. It is about
twenty lines: walk the content collection, emit `{ id, title, tags,
body }` per post into `search-index.json`, and have the search page
fetch it and hand it to MiniSearch on first interaction.

That is genuinely all of it, and it is not the interesting part of this
post. The interesting part is what it costs.

## The numbers

The important distinction, and the reason this section exists: **one
row below is measured. The rest are estimates**, extrapolated from a
synthetic corpus assembled out of this repo's own prose at 1,500 words
per post.

```
posts  raw JSON  gzip   +JS    on wire
1*       823 B   515 B  6.0K   ~6.5K
25       227 K    81 K  6.0K    ~87K
50       457 K   161 K  6.0K   ~167K
100      914 K   320 K  6.0K   ~326K
200      1.83M   639 K  6.0K   ~645K

* measured, 104 words. Rest estimated.
```

Roughly 9.36 KB raw and 3.3 KB gzipped per 1,500-word post, and it
scales linearly. A 3,000-word post roughly doubles its row; a 600-word
one roughly quarters it.

### The trap this table exists to prevent

At the time I made this decision I had two real posts and an
823-byte index. The natural move is to multiply.

Two hundred times 823 bytes is 119 KB, which sounds completely fine,
and it is wrong by more than an order of magnitude. Those two posts
were stubs. The real number at 200 posts is about **1.83 MB raw**.

If you are sizing a client-side search index from the posts you have
today, and the posts you have today are short because the blog is new,
you are going to get an answer that is wrong in the direction that
makes you feel good about it.

### Where it stops being reasonable

- **Up to ~25 posts:** a non-issue. ~87 KB, once, on a page the reader
  deliberately navigated to. One medium photo.
- **~50 posts:** ~167 KB. Still defensible. This is where a careful
  person starts thinking about it.
- **~100 posts: the line.** ~326 KB on the wire, and roughly half a
  megabyte of index built in phone memory before the first keystroke
  does anything.
- **~200 posts:** ~645 KB gzipped for a search box. Indefensible.
  Something must have changed before here.

### The comparison that hurts

Pagefind's own homepage claims a 10,000-page site searchable in under
300 KB, because it chunks its index and fetches only the parts a query
needs. Mine ships the whole thing.

So at 100 posts, my design is transferring more bytes than Pagefind
needs for a hundred times the content.

I am aware of how that reads next to the decision above. It is the
correct comparison and leaving it out would make this a worse post.

## The expiry date, written down

Before any of this measurement, I had written a revisit trigger into
the project notes: *when the index exceeds roughly 1 MB.*

At 9.36 KB raw per post, 1 MB is about **107 posts**. The independent
analysis above put the line at about 100. Two methods, one answer,
within a rounding error — which is a nicer result than I expected and
suggests the original guess was better than it deserved to be.

One caveat that must survive: 1 MB *raw* is about 350 KB
*transferred*. Cloudflare compresses; the reader's phone decompresses.
Quoting the raw number alone overstates the download and understates
the memory.

When it expires, in rough order of preference:

1. **Drop `body` from the index** and search titles and tags only. The
   body field is 55 KB raw at 200 posts on these measurements — it is
   most of the weight.
2. **Generate the index on a 4 KB-page machine** and commit the
   artefact.
3. **Pin Pagefind after all.** Which, as of today, I know is a live
   option rather than a wish.

## What I did not measure

Being explicit, because the table above invites over-reading:

- **No real-device timings.** The index-build times I have are Node on
  the Pi. No browser, no phone, no throttled network. Nothing here
  supports a claim about how fast this feels in someone's hand.
- **No brotli.** `brotli` is not installed on this box. Cloudflare very
  likely serves it and would beat the gzip column by something like
  15-20%, but that is an industry figure, not a measurement of this
  index. Every compressed number above is gzip.
- **No heap measurement.** The "half a megabyte in phone memory" figure
  is `toJSON()` byte length, which is a proxy for the structure, not a
  measurement of what a browser actually allocates.

One small thing I did learn while measuring, which cost me twenty
confusing minutes: `gzip` stores the original filename in its header,
so byte-identical content compresses to different sizes under different
names. Use `gzip -n` when you are comparing.

## The short version

The best tool for this job runs on my hardware if I pin it two releases
back. I chose not to, because a pin that predates the fix you are
waiting for is a debt with no due date — and because at this blog's
size the difference is a few dozen kilobytes on a page nobody has
visited yet.

I also wrote down the post count at which that stops being true. It is
about a hundred, and I got there twice by different routes.

---

*Verified on this box 2026-09-06: Raspberry Pi 5, `getconf PAGESIZE` =
16384. The Pagefind version matrix and the 1.5.0 index run were
executed the same day. MiniSearch 7.2.0. Every row of the size table
below "1 post" is an estimate from a synthetic corpus and is labelled
as such; check Pagefind's own published figures before relying on the
comparison.*
