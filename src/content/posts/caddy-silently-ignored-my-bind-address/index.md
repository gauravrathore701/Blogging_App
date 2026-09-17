---
title: "I told Caddy on my Raspberry Pi to stay on localhost. It listened everywhere and spoke HTTPS instead."
description: "127.0.0.1:4184 in a Caddyfile gave me a 400 for plain HTTP and a port bound on every interface. Two separate Caddy behaviours, one typo, and the obvious fix hides only one."
date: 2026-09-05
category: tech
tags: ["caddy", "tls", "networking", "self-hosting", "raspberry-pi"]
draft: true
---

On 2 September I set up a dev copy of this blog on my Raspberry Pi, served by Caddy, and asked for it on `127.0.0.1:4184` — local only, nothing else on the network should see it. Two things went wrong at once. Requests got back a `400 Bad Request`, even though I hadn't configured HTTPS anywhere. And the port wasn't bound to loopback at all: it was listening on `*:4184`, every network interface on the Pi. My note from that night says it in one line: *a bare `127.0.0.1:4184` site address returned 400 and still bound `*:4184`.*

When I reproduced it on a spare port, the 400 came with this body:

```
HTTP/1.0 400 Bad Request

Client sent an HTTP request to an HTTPS server.
```

So: no TLS configured, a TLS error anyway, and a "local only" site that wasn't. Neither of those is a Caddy bug. Both are documented behaviour. And — this is the bit that makes it nasty — they're **two separate mechanisms that happen to share one typo**, so fixing the error you can see doesn't fix the one you can't.

## You're probably here for a different 400

`Client sent an HTTP request to an HTTPS server.` is a very popular error string, and nearly every page about it is about a reverse proxy: the client talks HTTPS and the backend talks HTTP, or the other way round. The Caddy forum threads carrying this exact message mostly come down to that kind of scheme mix-up, and one of them turned out to be two Caddy instances fighting over the same port.

If you've got a `reverse_proxy` line, check its scheme first. You might be done in a minute.

This post is about the other cause: **there's a host in your site address**, and nobody told you that's a TLS switch.

## One read-only command explains everything

`caddy adapt` compiles a Caddyfile into Caddy's native JSON and prints it. It doesn't load it, doesn't touch the running server, and doesn't open a socket. It's the debugging tool I should have reached for first, and it settles this whole thing.

Here's the broken form, stripped down to a site address and a response:

```caddyfile
127.0.0.1:45999 {
	respond "ok" 200
}
```

And here's what it compiles to:

```json
"srv0": {
  "listen": [":45999"],
  "routes": [{
    "match": [{"host": ["127.0.0.1"]}],
    "handle": [...],
    "terminal": true
  }]
}
```

Look at the two keys.

`"listen"` is `":45999"` — no host, which means every interface. The `127.0.0.1` I typed isn't there at all.

It's in `"match"` instead. It became a **`Host` header matcher**.

That's the whole misunderstanding in four lines of JSON. In Caddy, a site address is a *routing* rule, not a socket address. The host part decides which requests a site answers. It doesn't decide where Caddy listens.

## Every address I tried listens everywhere

I ran each form through `caddy adapt` (on 2026-09-02 and 2026-09-05, and again on 2026-09-17, all on Caddy 2.6.2). All four listen on every interface:

| site address | `listen` | route matcher |
|---|---|---|
| `127.0.0.1:45999` | `[":45999"]` | host `127.0.0.1` |
| `:45999` | `[":45999"]` | none |
| `http://127.0.0.1:45999` | `[":45999"]` | host `127.0.0.1` |
| `localhost:45999` | `[":45999"]` | host `localhost` |

Every row. There's no way to write a site address that changes the listening interface, because that's not a site address's job.

`bind` is what changes it:

```
:45999 { bind 127.0.0.1 }
  →  "listen": ["127.0.0.1:45999"]
```

Caddy's docs say so in one sentence, on the Caddyfile concepts page:

> By default, sites bind on all network interfaces. If you wish to
> override this, use the `bind` directive or the `default_bind` global
> option to do so.

That sentence is correct, complete, and nowhere near where your eyes are when you're typing what you believe is a bind address.

## So where did the 400 come from?

Same page, a little further up:

> Automatic HTTPS is enabled if your site's address contains a hostname
> or IP address.

**Or IP address.** `127.0.0.1` counts.

By putting a host in the site address, I didn't just add a matcher. I told Caddy this site has an identity, and Caddy did what it's famous for: it switched on HTTPS. On port 45999. Unasked. Very helpful. Thanks, Caddy.

Now the listener speaks TLS. Anything that sends it plain HTTP — curl, a health check, a tunnel — sends bytes that are very obviously not the start of a TLS handshake, and the connection dies before a single HTTP header gets read.

That error text isn't even Caddy's. It's Go's standard library, from `net/http`'s `server.go`:

```go
if re, ok := err.(tls.RecordHeaderError); ok && re.Conn != nil && tlsRecordHeaderLooksLikeHTTP(re.RecordHeader) {
    io.WriteString(re.Conn, "HTTP/1.0 400 Bad Request\r\n\r\nClient sent an HTTP request to an HTTPS server.\n")
    re.Conn.Close()
```

That's why the reply says `HTTP/1.0` and has no headers. It isn't really a response. It's 76 bytes written straight onto the socket from the TLS error path, followed by a hang-up.

## Proof it's TLS, not a matcher that didn't match

The intuitive explanation is "the host matcher didn't match". It's wrong, and two measurements from 2 September kill it. Both came from throwaway Caddy runs on port 45999.

**One: the same broken config answers 200 over HTTPS on the same port.**

```
### site address = 127.0.0.1:45999
  listening: *:45999
  plain HTTP GET -> 400
  body: Client sent an HTTP request
        to an HTTPS server.
  HTTPS GET      -> 200
```

A matcher miss would fail over HTTPS too. The route is fine. The transport is the problem.

**Two: every `Host` header gets a 400, including the one that should match.**

```
  Host: 127.0.0.1:45999        -> 400
  Host: 127.0.0.1              -> 400
  Host: dev.cursedshrine.com   -> 400
  Host: localhost:45999        -> 400
  Host: 192.168.1.50:45999     -> 400
```

The request never reached the matcher. There wasn't a request. There was a failed TLS handshake and a canned string.

## The fix that makes the error vanish is a trap

This is the part I haven't seen written down anywhere, and it's why this post exists.

You hit the 400. You search it. Someone tells you to spell out the scheme. You change the site address to `http://127.0.0.1:45999`, and it works:

```
### site address = http://127.0.0.1:45999
  listening: *:45999
  plain HTTP GET -> 200
  body: matched
```

Clean 200. Error gone. You close the tab and go make tea.

Now read line two again: `listening: *:45999`. Still every interface. You've just put your dev site on your whole local network, and the only symptom you had — the 400 — is the thing you just made disappear.

The adapt output shows exactly what `http://` changed:

```json
"automatic_https": {"skip": ["127.0.0.1"]}
```

That's the entire effect. It tells Caddy to skip automatic HTTPS for that host. It's a TLS instruction and says nothing about sockets, because site addresses never do.

**Making the error go away is not the same as fixing it.**

## Two problems, one typo

To be sure these really are independent, I ran one more throwaway config with a host in the site address *and* a `bind`:

```
### 127.0.0.1:45999 { bind 127.0.0.1 }
  listening: 127.0.0.1:45999
  plain HTTP -> 400
  body: Client sent an HTTP request
        to an HTTPS server.
  HTTPS      -> 200
```

`bind` fixed the interface. The 400 stayed exactly where it was.

| symptom | caused by | fixed by |
|---|---|---|
| listens on `*:PORT` | a site address isn't a bind address; the default is every interface | `bind` |
| `400 … HTTPS server` | a host in the site address turns on automatic HTTPS | dropping the host |

Neither fix is enough on its own. The correct form is a **port-only site address plus a separate `bind`**.

## `bind` wants a host. Never a port.

From the `bind` directive docs:

> This directive accepts only a host, not a port. The port is
> determined by the site address (defaulting to 443).

So the two halves live in different places on purpose: the port goes in the site address, the interface goes in `bind`. If years of Unix networking have taught you that `host:port` is one unit, this reads backwards the first three times.

Also worth knowing: giving `bind` a port doesn't get you an error. It gets you this:

```
bind 127.0.0.1:45999
  →  "listen": ["[127.0.0.1:45999]:45999"]
```

Square brackets are how IPv6 addresses are written, so Caddy has treated `127.0.0.1:45999` as one big host name and stuck the real port on the end. `caddy adapt` accepts it without complaint. I didn't start a server with it to see how it fails — but whatever it does, it isn't what you meant.

## Bonus damage: a new root certificate

The first time I ran the broken form with automatic HTTPS left at its default, Caddy didn't just switch to TLS. It went to get a certificate for `127.0.0.1`. That isn't a public name, so Caddy made one from its own local certificate authority — and installed that authority into the Pi's system trust store:

```
{"level":"info","msg":"certificate installed
  properly in linux trusts"}
```

Then it failed to start at all:

```
Error: loading initial config: loading new
config: http app module: start: listening on
:80: listen tcp :80: bind: permission denied
```

Because automatic HTTPS also wants port 80, for the HTTP-to-HTTPS redirect.

So the full bill for one host in one site address: a TLS listener I didn't ask for, a `Caddy Local Authority` root certificate in `/usr/local/share/ca-certificates/`, and an attempt to grab a privileged port. I removed the root and ran `update-ca-certificates --fresh`. Checked again on 2026-09-17: that folder is empty and there's no Caddy root in the system bundle.

Every step is what the automatic HTTPS docs say happens when Caddy knows a name it's serving. I just never meant to tell it one.

## What fixed it

The dev site and the production site on this Pi now both use a port-only site address with a separate `bind`. Here's `/etc/caddy/Caddyfile`, trimmed to the part that matters:

```caddyfile
:4184 {
	bind 127.0.0.1
	root * /srv/blog-dev
	encode zstd gzip
	header X-Robots-Tag "noindex, nofollow, noarchive"
	...
}

:4182 {
	bind 127.0.0.1
	root * /srv/blog
	encode zstd gzip
	...
}
```

Compiled, that's:

```
$ caddy adapt --config /etc/caddy/Caddyfile \
  | grep -o '"listen":\[[^]]*\]'
"listen":["127.0.0.1:4182"]
"listen":["127.0.0.1:4184"]
```

And what the kernel actually has open, checked on 2026-09-17:

```
$ ss -lnt | grep -E ':418[24] '
LISTEN 0 4096 127.0.0.1:4182 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:4184 0.0.0.0:*
```

No host anywhere in the config, so no automatic HTTPS, so no 400. An explicit `bind`, so no wildcard. Both sites are reachable only from the Pi itself; anything public in front of them comes in through a tunnel, which is [a different post](/blog/posts/one-pi-one-tunnel-many-sites/).

The habit I've kept from this: **after any Caddyfile change, check `ss`, not `curl`.** `curl` tells you the site works. It can't tell you who else it works for.

## Versions, and what I didn't check

Everything measured here is Caddy **2.6.2**, as packaged by Debian trixie (`2.6.2-12+deb13u1`). Upstream released 2.6.2 on 2022-10-13. The latest stable release, as of 2026-09-17, is 2.11.4 from 2026-06-03. That's a big gap, so to be straight about it: **I haven't run any of this on a current build.**

What I can say is that Caddy's current docs still describe exactly this design. I re-fetched the concepts page and the `bind` page on 2026-09-17, and the three sentences quoted above are on them word for word. That's documentation, not a measurement. If you're on 2.11.x, run `caddy adapt` on your own Caddyfile rather than trusting my 2.6.2.

I also don't know which client first hit that 400 on port 4184; my note only records the symptom.

And since this could read like a complaint: **the documentation is correct and complete.** Everything I needed was there. The catch is that it's spread out — "the host is a matcher", "sites bind to all interfaces" and "a host turns on automatic HTTPS" are three separate sentences in separate sections, and none of them is in front of you while you're typing what you think is a bind address.

`caddy adapt` puts all three in front of you at once. Run it before you trust a Caddyfile.

---

*Observed on this Pi: Caddy 2.6.2 (Debian `2.6.2-12+deb13u1`, built with go1.24.4). The original incident is from 2026-09-02. The throwaway runtime tests (400 vs 200, Host headers, bind + host, CA install) were run on 2026-09-02. The `caddy adapt` results, the live `ss` output, the trust-store check, the doc quotes and the release dates were re-checked on 2026-09-17.*
