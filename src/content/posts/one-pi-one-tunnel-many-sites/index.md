---
title: "One Pi, one tunnel, ten sites, and one rule that could never run"
description: "Ten local services behind one Cloudflare Tunnel on a Raspberry Pi. My /blog rule only works because it sits above the apex rule, and cloudflared tunnel ingress validate prints OK either way."
date: 2026-09-05
category: tech
tags: ["cloudflare-tunnel", "cloudflared", "raspberry-pi", "self-hosting"]
draft: true
---

There is a config file on this Raspberry Pi where two rules can be
swapped, the swap is undetectable by every check the tool ships with,
and one of the two orderings means my blog is unreachable by any
request, ever.

The tool's own validator prints `OK` on both.

```
$ cloudflared --config /tmp/cfd-check/wrong-order.yml \
    tunnel ingress validate
Validating rules from /tmp/cfd-check/wrong-order.yml
OK
```

That is the broken one.

## The shape: one process, ten backends

Everything public on this box goes through a single Cloudflare Tunnel.
One `cloudflared` process, one config file, no ports open on the
router:

```
$ pgrep -c -x cloudflared
1
$ ps -o pid,etime,rss,comm -C cloudflared
    PID     ELAPSED   RSS COMMAND
 149242  3-07:02:22 43552 cloudflared
```

One process, about 42 MiB resident, three days up, fronting everything.
That is the entire appeal of this setup. The alternative — a tunnel per
site — is ten daemons, ten credential files and ten things to restart.

**Ten** is a number I had to actually count, because I had it wrong
twice. Here is the counting, from the live config with comments
excluded:

```
$ cfg=~/.cloudflared/config.yml
$ grep -v '^\s*#' $cfg | grep -c 'hostname:'
13
$ grep -v '^\s*#' $cfg | grep -oP '(?<=hostname: ).*' | sort -u | wc -l
11
$ grep -v '^\s*#' $cfg | grep -oP 'localhost:\K[0-9]+' | sort -un | wc -l
10
```

Thirteen `hostname:` keys, eleven distinct hostnames, ten distinct
local ports. The gaps are all explainable:

- Two hostnames appear twice, because the apex and its `www` alias each
  need a second rule for the `/blog` subpath. That is 13 keys down to 11
  hostnames.
- One of the eleven hostnames does not point at a local port at all. It
  points at `http_status:404` — a service I switched off, whose DNS
  record I left with somewhere to land. It serves nothing, so it is not
  a site.

That leaves **ten distinct local ports fronted by one tunnel**, and
that is the number in the title. If you prefer to count hostnames, it
is ten of those too, which is a coincidence rather than a rule.

Drop the `grep -v '^\s*#'` and you get eleven ports, because there is a
commented-out `service:` line in the file. That is how I got the number
wrong the first time. Counting infrastructure by grepping YAML is a
thing you should do carefully or not at all.

Here is the part of the ingress list that matters. I have trimmed it —
these hostnames are all public DNS, but there is no reason to publish a
list of every service on one machine, so the eight single-hostname
rules are elided:

```yaml
ingress:
  # MUST stay above the plain apex rules below, or 4176 swallows /blog.
  - hostname: cursedshrine.com
    path: ^/blog
    service: http://localhost:4182
  - hostname: www.cursedshrine.com
    path: ^/blog
    service: http://localhost:4182
  - hostname: cursedshrine.com
    service: http://localhost:4176
  - hostname: www.cursedshrine.com
    service: http://localhost:4176

  # ... eight more one-hostname rules, one app each ...

  - service: http_status:404
```

The mapping is the whole model: **hostname (and optionally path) in,
`localhost:PORT` out.** Cloudflare terminates TLS at the edge, the
tunnel carries the request to this Pi, and `cloudflared` hands it to a
plain HTTP port on loopback. There is no inbound firewall rule
anywhere, because there is no inbound connection — the daemon dials
out.

## The subpath problem

Nine of the ten backends are boring. One hostname, one port, no way to
get it wrong.

The blog is the exception. `cursedshrine.com` was already an app on
port 4176 before this blog existed, and I did not want a
`blog.` subdomain. So the blog lives at `cursedshrine.com/blog`, served
by a different local server on 4182, on a hostname that is already
claimed.

That means two rules for one hostname. And two rules for one hostname
is the only situation in which ingress ordering can hurt you.

## Why the natural order is the wrong order

Cloudflare documents both halves of this. From the tunnel
configuration-file reference:

> When `cloudflared` receives an incoming request, it evaluates each
> ingress rule from top to bottom to find which rule matches the request.

and, a little further down:

> If a rule does not specify a path, all paths will be matched.

Those two sentences are the entire bug, and they are on the same page,
and nothing on that page puts them together for you. The Go package
docs for `cloudflared/ingress` say the same thing in code terms:
`Ingress.FindMatchingRule` "returns the index of the Ingress Rule which
matches the given hostname and path" — first match by index, wins.

So: a rule with only a `hostname:` matches every path on that hostname.
Which means the general rule is the *short* one and the specific rule is
the *long* one. When you sit down to add a subpath to a hostname you
already have, the instinct is to write the existing rule first and the
new special case after it. That instinct is exactly backwards, and it
produces a file that reads perfectly well.

## What the wrong order does

I want to be precise about this, because I have seen this written up as
a war story and mine is not one: **this never broke on me.** I got the
ordering right the first time, because I happened to be thinking about
first-match-wins that evening, and I left a comment in the file saying
so. What follows is a reconstruction I ran on purpose, in `/tmp`, with
the live config untouched.

The scratch file, with the two rules swapped:

```yaml
ingress:
  - hostname: example.com
    service: http://localhost:4176
  - hostname: example.com
    path: ^/blog
    service: http://localhost:4182
  - service: http_status:404
```

`cloudflared tunnel ingress rule <url>` evaluates a URL against a rule
file and prints the first rule that matches. It reads the file. It does
not talk to the tunnel, does not reload anything, and does not require
the daemon to be stopped:

```
$ cloudflared --config /tmp/cfd-check/wrong-order.yml \
    tunnel ingress rule https://example.com/blog/
Matched rule #0
	hostname: example.com
	service: http://localhost:4176

$ ... tunnel ingress rule https://example.com/blog/some-post/
Matched rule #0
	hostname: example.com
	service: http://localhost:4176

$ ... tunnel ingress rule https://example.com/
Matched rule #0
	hostname: example.com
	service: http://localhost:4176
```

Every request. Including `/blog/`. The path rule sitting one line below
is unreachable — not misconfigured, not shadowed some of the time,
simply never consulted, because the rule above it matches all paths on
that hostname.

And the failure this produces is a liar. The blog does not go down with
a tunnel error. The request reaches the apex app, the apex app has no
route for `/blog/`, and the apex app returns its own 404. What you see
is a 404 from your blog's URL immediately after a blog deploy, which
looks exactly like a broken deploy. You will go and check your build
output. The build was fine.

For contrast, the live config with the rules the right way around:

```
$ cloudflared --config ~/.cloudflared/config.yml \
    tunnel ingress rule https://cursedshrine.com/blog/
Matched rule #0
	hostname: cursedshrine.com
	path: ^/blog
	service: http://localhost:4182

$ ... tunnel ingress rule https://cursedshrine.com/
Matched rule #2
	hostname: cursedshrine.com
	service: http://localhost:4176
```

`/blog/` to 4182, `/` to 4176. Two rules, one hostname, and the only
thing keeping them apart is line order.

## The turn: the validator has nothing to say about it

Both of those files pass validation.

```
$ cloudflared --config /tmp/cfd-check/wrong-order.yml tunnel ingress validate
Validating rules from /tmp/cfd-check/wrong-order.yml
OK

$ cloudflared --config ~/.cloudflared/config.yml tunnel ingress validate
Validating rules from /home/gaurav/.cloudflared/config.yml
OK
```

`OK` on the config that can never serve the blog, and `OK` on the one
that can. If your habit is "edit the file, validate it, reload the
daemon" — and that is a good habit, it is why the command exists — the
validator will wave you through the one change you actually needed
catching.

I do not want to be unfair to `validate`, because it is not a no-op.
It catches real things. Give it a regex Go cannot compile:

```
$ cloudflared --config /tmp/cfd-check/lookahead.yml tunnel ingress validate
Validating rules from /tmp/cfd-check/lookahead.yml
Validation failed: Rule #1 has an invalid regex: error parsing regexp: invalid or unsupported Perl syntax: `(?!`
```

That was `path: ^/blog(?!roll)`. Cloudflare parses path regexes with
Go's `regexp`, which is RE2 — no lookaround, no backreferences. Useful
to learn at validate time rather than at request time.

Take away the catch-all and it complains about that too:

```
$ cloudflared --config /tmp/cfd-check/nocatchall.yml tunnel ingress validate
Validating rules from /tmp/cfd-check/nocatchall.yml
Validation failed: The last ingress rule must match all URLs (i.e. it should not have a hostname or path filter)
```

So `validate` checks two things: every rule is syntactically valid, and
the last rule catches everything. Both are worth checking. Neither is
*reachability*. Whether any request can ever reach rule #1 is not a
question it asks, and as far as I can tell nothing in the toolchain
asks it.

That is why `ingress rule` is the command that actually protects you.
One URL at a time is tedious, but it answers the question you have.

## Verify before you reload

The advice you find in forum threads is: edit, reload, curl, guess.
Checking the routing table before touching the running daemon is
strictly better and costs one command per URL I care about.

Mine is roughly this, and it runs against the file, not the tunnel:

```
for u in https://cursedshrine.com/ \
         https://cursedshrine.com/blog/ \
         https://cursedshrine.com/blog/some-post/ ; do
  echo "--- $u"
  cloudflared --config ~/.cloudflared/config.yml tunnel ingress rule "$u"
done
```

One gotcha worth knowing, because it cost me a minute of confusion:
**the two commands number the rules differently.** `ingress rule`
counts from zero, and `validate` counts from one. Same file, second
rule:

```
$ ... tunnel ingress rule https://example.com/     # second rule matches
Matched rule #1

$ ... tunnel ingress validate                      # bad regex on second rule
Validation failed: Rule #2 has an invalid regex: ...
```

`Matched rule #1` and `Rule #2` are the same line of YAML. If you are
counting down the file to find the rule a validation error is
complaining about, subtract one.

## `^/blog` is anchored at one end only

The path is a regex, and `^` anchors the start. That does what you want
at the front:

```
$ ... tunnel ingress rule https://cursedshrine.com/x/blog
Matched rule #2
	hostname: cursedshrine.com
	service: http://localhost:4176
```

`/x/blog` falls through to the apex, correctly. But there is no
boundary at the other end:

```
$ ... tunnel ingress rule https://cursedshrine.com/blogsomething
Matched rule #0
	hostname: cursedshrine.com
	path: ^/blog
	service: http://localhost:4182
```

`/blogsomething`, `/blogroll`, `/blogging` — all routed to the blog
backend. On this box that is harmless, because the local server just
404s them:

```
https://cursedshrine.com/blogsomething        -> 404
```

On a box where the apex app owns `/blogroll`, it is a live routing bug
that only shows up on one URL. The tighter form fixes it, and I checked
that it does rather than assuming:

```
# path: ^/blog(/|$)
/blog            -> 4182
/blog/           -> 4182
/blog/post/      -> 4182
/blogsomething   -> 4176
```

One thing I could not find documented and so tested directly: **the
query string is not part of what `path` matches.** A rule of `^/blog`
does not catch a request to `/` that merely mentions `/blog` in a
parameter:

```
/?redirect=/blog  -> 4176   (apex)
/x?/blog          -> 4176   (apex)
/blog?x=1         -> 4182   (blog)
```

Path only. That is what I wanted, but I would not have bet money on it
before running it.

## What this setup does not give you

Some honest limits, because the ten-sites-one-process framing sounds
tidier than it is.

**One config is one blast radius.** Ten sites share a file, a process
and a reload. A YAML mistake in the rule for a toy game takes down
everything on the box. The failure modes I care about are not "the
tunnel is down" but "I edited the tunnel".

**First-match-wins does not compose.** Every time I add a hostname I am
appending to a list whose meaning depends on position. There is no
namespacing and no per-site file to include. At ten rules that is fine.
I do not know what this feels like at fifty, and I have not tried.

**Everything here is a locally-managed tunnel** — a YAML file on the
box. Cloudflare also offers dashboard-managed tunnels where the ingress
list lives in their UI. I have not checked whether those apply the same
ordering semantics, and I am not going to assume they do. If that is
your setup, treat this post as a hypothesis and test it.

**All of this is `cloudflared version 2025.11.1`** (built 2025-11-07).
Every output above came off that build. I have not tested older or
newer versions, and "the validator does not check reachability" is the
kind of thing that could quietly become false in a release.

**And the tunnel is only half the path.** Every rule here ends at
`http://localhost:PORT`. Something on this Pi still has to be listening
on that port, on the right interface, speaking plain HTTP. Getting
`localhost:4182` to bind correctly turned out to be its own hour, and
its own post.

Live, as of today:

```
https://cursedshrine.com/                     -> 200
https://cursedshrine.com/blog/                -> 200
https://cursedshrine.com/blogsomething        -> 404
```

## The rule worth keeping

**When a config file is a first-match-wins list, "valid" and "correct"
are different questions, and your tooling probably only answers the
first one.**

Ingress rules, firewall chains, nginx `location` blocks, routing tables,
`.gitignore` — the shape recurs. Every one of them will happily accept a
line that can never be reached, and most will not tell you. If a tool
gives you a way to ask "what actually matches this input", that command
is worth more than the one that says `OK`.
