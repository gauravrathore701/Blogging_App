---
title: "Three quarters of the traffic to my site was a 404"
description: "Cloudflare said I had 1.84k visitors. My server's own log said 76% of requests were for pages that don't exist. I wrote a rule to block them, checked it properly, and found it only caught about half."
date: 2026-09-06
category: tech
tags: ["cloudflare", "waf", "self-hosting", "logs", "security"]
draft: false
---

My Cloudflare dashboard said my site had 1.84k unique visitors and 28.8k requests in the last thirty days. For a personal site running on a Raspberry Pi, that felt pretty good.

One note before I pick that number apart. It comes from the Cloudflare dashboard, and I can't re-check it from the Pi, because there's no Cloudflare API token on it. Everything else in this post I measured myself. That one number is just what the dashboard showed me.

So I went to look at my server's own log to see who these visitors were.

## The log folder was empty

First surprise. The blog runs on Caddy, so I assumed the log for the main site would be in Caddy's log folder.

```
$ ls -la /var/log/caddy/
total 8
drwxr-xr-x 2 caddy caddy 4096 Sep  2 01:33 .
```

Empty. It turns out the main `cursedshrine.com` page isn't served by Caddy at all. It's a tiny Python web server (`http.server`) running as a background service. That server prints its log to the screen instead of a file, so systemd catches it and stores it in the system journal. That's where the log was.

```
$ journalctl -u homepage-cursedshrine \
    --since "2026-09-03" -o short-iso
```

That worked, but with a catch that affects every number below: **the journal for this service only went back to 3 September, 03:00.** I wanted a week of data. I had four days. So every number in this post covers 3 September to midday on 6 September. I'm not going to round that up to "a week" just because it sounds better.

## Where the traffic went

Here's what four days of requests looked like:

```
total   4750
404     3607   75.9%
501      844   17.8%
200      297    6.3%
```

Three out of every four requests were a **404**, meaning "that page doesn't exist". They asked for 1,251 different paths, and none of them are real. My site has no PHP and no WordPress, and it never has.

The **501s** surprised me more, and I haven't seen anyone else write about them. The little Python server only knows how to answer `GET` and `HEAD` requests, which are the normal "give me a page" kind. It doesn't handle `POST`, the "here's some data" kind. So all 844 POST requests got **501 Not Implemented** back:

```
/wordpress/wp-json/batch/v1    50
/?rest_route=/batch/v1         29
/                              27
/wp-json/batch/v1              26
/wp/wp-json/Batch/v1           25
```

That's almost a fifth of all my traffic, and a headline like "76% were 404s" hides it completely.

It's also bad news in a quiet way. From the scanner's side, a 501 is more useful than a 404. A 404 only says "nothing here". A 501 says "there's a real, working server here, it read your request, and it said no". That tells the scanner the machine is alive.

## What the bots were looking for

Most of it was WordPress. `wp-json` showed up 452 times, paths starting with `/wp/` 411 times, and `/wordpress/` 398 times. `/wp-admin/install.php?step=1` came up 37 times. That's the WordPress installer, and on a fresh WordPress install it will happily let a stranger connect the site to their own database. `/wp-login.php` came up 19 times, and `/.git/config` 15.

Then there were the `.env` files. These are files where apps often keep passwords and API keys. I expected bots to try a few different names. I counted how many *different* paths containing `.env` showed up in four days:

```
330
```

Three hundred and thirty. `/.env`, `/.env.prod`, `/.env.production`, `/.env.bak`, `/.env.backup`, `/.env.old`, `/.env.save`, `/.env.local`, `/.env.example`, `/backend/.env`, `/app/.env`, `/api/.env`, `/admin/.env`, `/laravel/.env`, `/config/.env`, `/server/.env`, `/public/.env`, `/src/.env`, `/web/.env`, and about three hundred more. Someone out there has a very long list.

One more small detail. The same bots asked for the same address with two different capitals:

```
...Batch/v1    75
...batch/v1   505
```

Same target, different capitalisation. Bots mix up their capitals, so a blocking rule shouldn't care about uppercase versus lowercase. Keep that in mind for later.

## My site said it had a robots.txt. It didn't.

I wasn't looking for this one. When I sorted the 404s by how often they happened, the top two weren't attacks at all:

```
/robots.txt    88
/sitemap.xml   57
```

These were the two most-requested missing files on my whole site. Search engine crawlers kept asking for them and kept getting nothing.

Except, from the outside, it looked fine. If you opened `https://cursedshrine.com/robots.txt` in a browser, you got a real page back (a 200). But on my actual server, the same file was a 404. Both were true at once, because Cloudflare has a feature that makes up a `robots.txt` for you if you don't have one. Its version was a short note about AI training and search indexing, and it didn't mention my sitemap at all.

So "my site has a robots.txt" was technically true all along, and completely useless. The file existed, but only on Cloudflare's side, and it didn't point crawlers to any of my content.

If you read my post about the Astro `base` setting that quietly broke my sitemap, this is the same kind of problem. The file exists, something says everything is fine, and the things that need it still can't find it.

So I wrote a real `robots.txt` that points to my sitemaps, and served it from my own server. Both files started working in the same second:

```
2026-09-06 12:26:20 IST /robots.txt  200
2026-09-06 12:26:20 IST /sitemap.xml 200
```

Cloudflare now serves my file, with two `Sitemap:` lines in it.

## The blocking rule

Cloudflare's free plan lets you create five custom firewall rules. I used one. It blocks any request whose path contains one of six patterns: `wp-`, `/wp/`, `wordpress`, `.env`, `.git`, or anything ending in `.php`. I wrapped the whole thing in `lower()`, which turns the path into lowercase before checking it. That way `/WP-LOGIN.PHP` gets caught just like `/wp-login.php`.

Before switching on anything that blocks people, I listed every path my own sites actually use, and checked that none of them matched the patterns. Then I tested the live site from the outside:

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

**403** means "blocked", and **200** means the page loaded normally. The uppercase version is blocked too, so `lower()` works, and my real pages still load.

That process matters more than my exact patterns. **A blocking rule you can't confidently undo is worse than the scanning it stops.** Write down what your site actually serves, prove the rule doesn't touch any of it, and keep a before-and-after table. That way, if the numbers change later, you can tell whether it was the rule or something else.

## Then I checked my own fix

This is where I expected to write "and it worked" and finish the post. Instead, I ran the rule's six patterns against all 3,607 real 404s from the log, to see how many it would actually have blocked.

```
would be blocked   1900   53%
would sail past    1707   47%
```

Only just over half.

About 145 of the ones that got through were `robots.txt` and `sitemap.xml`. Those are partly real search engines, and I serve those files now anyway. That still leaves around 1,562 hostile requests my rule doesn't touch.

I took the most common ones and tested each against the live site. Here, a **404** means the request got past Cloudflare and reached my server. A 403 would have meant it was blocked.

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

Look at that list again, because these are the scary ones:

- `/.aws/credentials` is where Amazon's command-line tool keeps long-lasting access keys.
- `/.s3cfg` is the config file for s3cmd, a popular tool for Amazon's S3 storage. Same idea: keys.
- `/_ignition/health-check` is a Laravel debug page with a known security hole (CVE-2021-3129) that let attackers run their own code on the server.
- `/actuator/env` is a Spring Boot page that can print out all of an app's settings, passwords included.

None of them contain `wp-`, `.env`, `.git` or `.php`.

I had written a rule shaped around WordPress, because WordPress scans were the biggest thing in my log. It blocks those well. But the *loudest* traffic and the most *dangerous* traffic weren't the same traffic. Sorting by volume put the wrong thing at the top of my to-do list.

## What I'm not going to claim

The number of 404s dropped a lot over those four days:

```
2026-09-03  2033 total  1774 404
2026-09-04  2108 total  1350 404
2026-09-05   495 total   421 404
2026-09-06   114 total    62 404  (partial)
```

That looks like the rule working. It isn't proof of that, and I won't pretend it is. Split the same data by hour, and almost all of it sits in just three hours:

```
09-04 01h  799
09-04 07h  276
09-05 22h  275
```

Every other hour in those four days had single-digit numbers. With traffic that bursty and a window that short, "the bots just stopped" explains the drop just as well as "my rule stopped them". I'd need weeks of data to tell the difference, and I have days. So I don't know.

While I'm listing what I can't see, here's the biggest one. Every single line in my server's log shows the same visitor address:

```
127.0.0.1
```

That's the Pi talking to itself. Visitors reach my site through a Cloudflare tunnel, so from the Python server's point of view, every request comes from the tunnel on the same machine. Cloudflare does pass along the real visitor address in a header (`CF-Connecting-IP`), but this simple server doesn't log it. So I get no IP addresses, no idea which network or country anything came from, and no way to see who's sending the most requests. Counting paths wasn't the tool I wanted. It was the only one I had.

There's a similar trap in the successful requests. I counted 226 visits to my home page (`/`) that loaded fine, and for a moment I thought those were my real human visitors. But a bot request like `/?rest_route=/wp/v2/posts/999999` also loads fine, because the Python server ignores everything after the `?` and just shows the home page. So around sixty bot probes are sitting in my log disguised as normal page views. The real number of human visits is lower than 226, and this log can't tell me by how much.

## The number that actually means something

Cloudflare's analytics count everything that touches the whole domain. That's every subdomain, every bot, every scanner, and me. It even counts the night I streamed a few gigabytes of my own videos through my own tunnel and watched my traffic graph jump. It was never meant to count an audience, and it doesn't.

One more thing I need to say plainly: a `robots.txt` file stops none of this. Attack scanners don't read it. I'm spelling that out because a polite `robots.txt` is the first thing most people reach for, and against this kind of traffic it does nothing at all.

Once you take out the bots, the probes, the 501s and me, my personal site gets something like thirty visits a day.

That's fine. It's a real number, which is more than I could say for the other one.
