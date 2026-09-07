---
title: "Three quarters of the traffic to my site was a 404"
description: "The dashboard said 1.84k visitors. The origin log said 76% of requests were 404s. I wrote a blocking rule, then audited it and found it covered barely half."
date: 2026-09-06
category: tech
tags: ["cloudflare", "waf", "self-hosting", "logs", "security"]
draft: true
---

My Cloudflare dashboard said 1.84k unique visitors and 28.8k requests over thirty days. For a personal site on a Raspberry Pi, that reads like something is working.

I want to be precise about that number before I take it apart: it comes from the Cloudflare dashboard, and I cannot re-derive it on this box. There is no API token on the Pi. Everything else in this post I measured myself today; that one figure is a dashboard reading and I am reporting it as such.

Then I went looking for the origin log.

## /var/log/caddy was empty

That was the first surprise. Caddy serves the blog, so I assumed the apex access log lived there.

```
$ ls -la /var/log/caddy/
total 8
drwxr-xr-x 2 caddy caddy 4096 Sep  2 01:33 .
```

Nothing. The apex of `cursedshrine.com` is not Caddy at all — it is a small Python `http.server` running as a systemd unit, and the stdlib handler writes its access log to stdout. Which means systemd captures it, which means it is in journald and not in a file anywhere.

```
$ journalctl -u homepage-cursedshrine \
    --since "2026-09-03" -o short-iso
```

That works, with one catch I have to state before any of the numbers below, because it bounds all of them: **the unit's journal only goes back to 2026-09-03 03:00.** I wanted a week. I have four days. Every figure in this post is the window from 3 September to midday on 6 September, and I am not going to quietly call that "a week" because it made a rounder story.

## The split

Four days, parsed out of the journal:

```
total   4750
404     3607   75.9%
501      844   17.8%
200      297    6.3%
```

Three quarters of every request to my site was a 404. Across 1,251 distinct paths, none of which exist, because this zone runs no PHP, has no WordPress and never has.

The 501s are the part I did not expect, and they are the part nobody's blog post mentions. Python's `http.server` implements `GET` and `HEAD`. It does not implement `POST`. So every one of the 844 POST requests got back **501 Not Implemented**:

```
/wordpress/wp-json/batch/v1    50
/?rest_route=/batch/v1         29
/                              27
/wp-json/batch/v1              26
/wp/wp-json/Batch/v1           25
```

That is a fifth of my traffic in a status class the "76% were 404s" framing hides completely. It is also, if you think about it from the other side, a *better* response for the scanner than a 404. A 404 says the path is not there. A 501 says a live server received your POST, parsed it, understood the method, and declined. That is a confirmed host.

## What the paths were asking for

The single largest family is WordPress. `wp-json` appears 452 times. `/wp/` as a path prefix, 411. `/wordpress/`, 398. `/wp-admin/install.php?step=1` — the installer, which on a fresh WordPress will happily let you point it at your own database — 37 times. `/wp-login.php` 19. `/.git/config` 15.

Then there are the environment files. I expected a handful of spellings. I counted the distinct paths containing `.env` in four days:

```
330
```

Three hundred and thirty. `/.env`, `/.env.prod`, `/.env.production`, `/.env.bak`, `/.env.backup`, `/.env.old`, `/.env.save`, `/.env.local`, `/.env.example`, `/backend/.env`, `/app/.env`, `/api/.env`, `/admin/.env`, `/laravel/.env`, `/config/.env`, `/server/.env`, `/public/.env`, `/src/.env`, `/web/.env` — and three hundred more. Somebody has a very thorough list.

And one detail that turns out to matter more than anything else in this post. The same campaign hits both of these:

```
...Batch/v1    75
...batch/v1   505
```

Same endpoint, two capitalisations. If you write a matching rule that is case-sensitive, you catch 75 of 580. Hold onto that.

## The instrument was lying

Here is the thing I did not go looking for. Sort the 404s by frequency and the top two entries are not attack paths at all:

```
/robots.txt    88
/sitemap.xml   57
```

Those are the two most-requested missing files on my site. Crawlers were asking, constantly, and getting nothing.

Except that they were not getting nothing. Fetch `https://cursedshrine.com/robots.txt` from outside and it returns **200**. Fetch it at the origin and it returned **404**. Both were true at the same time, because Cloudflare's Managed `robots.txt` feature was synthesising a file I had never written — a content-signals preamble about AI training and search indexing, and no `Sitemap:` line at all.

So for months the sentence "my site has a robots.txt" was accurate and completely useless. The file existed, at the edge, saying nothing that pointed at any of my content.

If you have read my post on the Astro `base` bug that quietly broke my sitemap, this is the same failure wearing different clothes: the artefact exists, something reports success, and nothing that matters can find it.

I wrote a real one, with real sitemap lines, and served it from the origin. Both files flipped in the same second:

```
2026-09-06 12:26:20 IST /robots.txt  200
2026-09-06 12:26:20 IST /sitemap.xml 200
```

The edge now serves my file, with two `Sitemap:` lines in it.

## The rule

Cloudflare's free plan gives you five WAF custom rules. I used one, matching the URI path against six patterns — `wp-`, `/wp/`, `wordpress`, `.env`, `.git`, and anything ending `.php` — with the whole expression wrapped in `lower()`.

That `lower()` is not decoration. It is the 75-versus-505 split from earlier. Without it the rule catches an eighth of that campaign and you conclude it is working.

Before enabling anything that returns 403, I enumerated the paths my own stack actually serves and checked that none of them matched. Then I probed the live edge:

```
/wp-login.php                403
/WP-LOGIN.PHP                403
/wp-admin/install.php?step=1 403
/.env                        403
/.env.production             403
/xmlrpc.php                  403
/.git/config                 403
/blog/                       200
/                            200
```

The uppercase variant is blocked, so `lower()` is doing its job. The real paths still answer. That is the method worth stealing, and it is more important than my particular patterns: **a blocking rule you cannot roll back confidently is worse than the scanning it stops.** Enumerate what you serve, prove none of it matches, and keep the before-and-after table so you can tell later whether the rule or something else changed the numbers.

## Then I audited my own fix

This is where I expected to write a satisfied paragraph and stop. Instead I replayed the rule's six patterns against all 3,607 real 404s in the log, to see how many of them it would actually have caught.

```
would be blocked   1900   53%
would sail past    1707   47%
```

Just over half.

About 145 of the misses are `robots.txt` and `sitemap.xml`, which are partly honest crawlers and which I now serve anyway. That leaves roughly 1,562 hostile requests that my new rule does not touch. I pulled the top ones and probed each at the edge to confirm they are still reaching my origin — a 404 here means it got through, where a 403 would mean it was stopped:

```
path                     edge
/.aws/credentials         404
/.aws/config              404
/.s3cfg                   404
/credentials.json         404
/docker-compose.yml       404
/_ignition/health-check   404
/actuator/env             404
/settings.json            404
```

Read that list again. `/.aws/credentials` is where the AWS CLI keeps long-lived access keys. `/.s3cfg` is s3cmd's config, same story. `/_ignition/health-check` is the Laravel debug page behind CVE-2021-3129, which was remote code execution. `/actuator/env` is the Spring Boot actuator endpoint that will dump your environment, secrets included.

None of them contain `wp-`, `.env`, `.git` or `.php`.

I had written a WordPress-shaped rule, because WordPress-shaped scanning is what dominated the histogram. It does block that, well. But the loudest traffic and the most dangerous traffic were never the same traffic, and sorting by volume put exactly the wrong thing at the top of my list.

## What I am not going to claim

The 404 counts fall off a cliff across my four days:

```
2026-09-03  2033 total  1774 404
2026-09-04  2108 total  1350 404
2026-09-05   495 total   421 404
2026-09-06   114 total    62 404  (partial)
```

That looks like a rule working. It is not evidence that a rule worked, and I am not going to present it as one. Break the same data down by hour and almost all of the volume lives in three of them:

```
09-04 01h  799
09-04 07h  276
09-05 22h  275
```

Every other hour in four days is single digits. With bursts that size and a window that short, "the campaign ended" fits the data exactly as well as "the rule started". I would need weeks to separate those, and I have days. Unresolved.

While I am listing limits, here is the one that shaped the entire investigation. Every line in that origin log has the same remote address:

```
127.0.0.1
```

Requests arrive through a cloudflared tunnel, and Python's stdlib handler logs the socket peer — which is the tunnel — rather than the `CF-Connecting-IP` header the real client address arrives in. So at this origin there is no IP, no ASN, no geography, no rate-per-source. Nothing. Path histograms were not my preferred instrument; they were my only one.

There is a related trap in the 200s. I counted 226 requests to `/` that returned 200 and briefly thought that was my human traffic. But `/?rest_route=/wp/v2/posts/999999` also returns 200, because the Python server drops the query string and serves the index — so around sixty bot probes are sitting in my log looking like successful page views. The real number of human visits is somewhere below 226 and this log cannot tell me where.

## The number that means something

Cloudflare zone analytics is a *zone* metric. It counts every subdomain, every bot, every scanner, and it counts me — including the night I streamed a few gigabytes of my own media through my own tunnel and watched my traffic graph spike. That is not an audience measurement and was never designed to be one.

The one honest thing I can say is that `robots.txt` stops none of what I have described. Exploit scanners do not read it. I have to say that out loud because a polite robots.txt is the first fix almost everyone reaches for, and against this traffic it does exactly nothing.

Once you take out the bots, the probes, the 501s and me, my personal site gets something like thirty visits a day.

That is fine. It is a real number, which is more than the other one was.
