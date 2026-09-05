---
title: "Caddy silently ignored my bind address. It was never a bind address."
description: "I put 127.0.0.1:4184 in a Caddyfile. Caddy answered plain HTTP with a 400, and bound the port to every interface in the house. Two different documented mechanisms, one typo."
date: 2026-09-05
category: tech
tags: ["caddy", "tls", "networking", "self-hosting", "raspberry-pi"]
draft: true
---

I asked Caddy to serve a dev site on `127.0.0.1:4184`. This is what a
plaintext client got back:

```
HTTP/1.0 400 Bad Request

Client sent an HTTP request to an HTTPS server.
```

I had not configured TLS anywhere. No `tls` directive, no certificate,
no ACME, nothing. That was strange enough to investigate.

This is what I found while investigating, and it is the part that
actually mattered:

```
LISTEN 0  4096  *:4184  *:*
```

I asked for loopback. I got every interface on the box.

Both of those are documented Caddy behaviour. Neither of them is a bug.
And they are not one problem — they are **two independent mechanisms
that happen to share one typo**, which is why fixing the error you can
see does not fix the one you cannot.

## This is probably not the problem you searched for

`Client sent an HTTP request to an HTTPS server.` is a popular string,
and almost every page behind it is about a reverse proxy. Client speaks
HTTPS to your proxy, your proxy speaks HTTP to the backend, or the
other way round. `reverse_proxy https://…` versus `reverse_proxy …`.
The threads on the Caddy forum that carry this exact string resolve to
scheme mismatches and, in one case, two Caddy instances fighting over a
port.

If you have a `reverse_proxy` line, go check its scheme first. You will
be done in a minute.

This post is about the other cause: **there is a host in your site
address**, and you did not know that was a TLS switch.

## `caddy adapt` answers this in one read-only command

`caddy adapt` compiles a Caddyfile to Caddy's native JSON and prints
it. It does not load it, does not touch the running server, and does
not open a socket. It is the most under-used debugging tool Caddy
ships, and it settles this question completely.

Here is the broken form. Nothing but a site address and a response:

```caddyfile
127.0.0.1:45999 {
	respond "ok" 200
}
```

And here is what it compiles to:

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

Read the two keys.

`"listen"` is `":45999"` — the empty host, the wildcard interface. The
`127.0.0.1` I typed is not in there at all.

It is in `"match"` instead. It became a **`Host` header matcher**.

That is the entire misunderstanding in four lines of JSON. A site
address in Caddy is a *routing* expression, not a socket address. The
host part filters requests. It does not narrow the listener.

## The matrix

I ran every form I could think of through `caddy adapt` on 2026-09-05.
All four listen on the wildcard:

| site address | `listen` | route matcher |
|---|---|---|
| `127.0.0.1:45999` | `[":45999"]` | `[{"host": ["127.0.0.1"]}]` |
| `:45999` | `[":45999"]` | none |
| `http://127.0.0.1:45999` | `[":45999"]` | `[{"host": ["127.0.0.1"]}]` |
| `localhost:45999` | `[":45999"]` | `[{"host": ["localhost"]}]` |

Every single row. There is no site-address syntax that changes the
listening interface, because that is not what a site address is for.

Adding `bind` is what changes it:

```
:45999 { bind 127.0.0.1 }        ->  "listen": ["127.0.0.1:45999"]
```

The docs say this in one sentence, on the Caddyfile concepts page:

> By default, sites bind on all network interfaces. If you wish to
> override this, use the `bind` directive or the `default_bind` global
> option to do so.

That sentence is correct, complete, and nowhere near where you are
looking when you are typing what you believe is a bind address.

## So where did the 400 come from?

Same page, a few paragraphs up:

> Automatic HTTPS is enabled if your site's address contains a hostname
> or IP address.

**Or IP address.** `127.0.0.1` counts.

So by writing a host into the site address, I did not just add a
matcher. I told Caddy this site has an identity, and Caddy did the
thing it is famous for: it turned on HTTPS. On port 45999. Unasked.

The listener now speaks TLS. Anything that sends it plaintext — curl, a
health check, a tunnel daemon — gets a TLS record header that is
obviously not a TLS record header, and the connection dies before a
single HTTP header is parsed.

That error string is not even Caddy's. It is Go's standard library.
From `net/http`'s `server.go`:

```go
if re, ok := err.(tls.RecordHeaderError); ok && re.Conn != nil && tlsRecordHeaderLooksLikeHTTP(re.RecordHeader) {
    io.WriteString(re.Conn, "HTTP/1.0 400 Bad Request\r\n\r\nClient sent an HTTP request to an HTTPS server.\n")
    re.Conn.Close()
```

Which is why the response is `HTTP/1.0` and has no headers. It is not a
response. It is forty-six bytes written directly onto a socket by the
TLS handshake's error path, followed by a close.

## Proof it is TLS and not a matcher miss

This distinction matters, because "host matcher didn't match" is the
intuitive explanation and it is wrong. Two measurements kill it.

**One: the same config answers 200 over HTTPS on the same port.**

```
### site address = 127.0.0.1:45999
  listening: *:45999
  plain HTTP GET -> 400
  body: Client sent an HTTP request to an HTTPS server.
  HTTPS GET      -> 200
```

A matcher miss would fail over HTTPS too. The route is fine. The
transport is the problem.

**Two: every `Host` header gets 400, including the one that should
match.**

```
  Host: 127.0.0.1:45999        -> 400
  Host: 127.0.0.1              -> 400
  Host: dev.cursedshrine.com   -> 400
  Host: localhost:45999        -> 400
  Host: 192.168.1.50:45999     -> 400
```

The request never reached the matcher. There is no request. There is a
failed TLS handshake and a byte string.

## The trap inside the trap

Here is the part I have not seen written down anywhere, and it is the
reason I bothered with this post.

You hit the 400. You search it. Somebody tells you to put the scheme in
explicitly. You change the site address to `http://127.0.0.1:45999`,
and it works:

```
### site address = http://127.0.0.1:45999
  listening: *:45999
  plain HTTP GET -> 200
  body: matched
```

Clean 200. Error gone. You move on.

Look at line two. `listening: *:45999`. Still every interface. You have
just published a dev site to your entire LAN and the only symptom you
had — the 400 — is the thing you just deleted.

The adapt output shows exactly what `http://` did:

```json
"automatic_https": {"skip": ["127.0.0.1"]}
```

That is the whole effect. It skips automatic HTTPS for that host. It is
a TLS instruction. It says nothing about sockets, because site
addresses do not say anything about sockets.

**The fix that makes the error disappear is not the fix.**

## Two mechanisms, one typo

To make sure these really are independent, I ran a fourth config with
*both* mistakes at once — a host in the site address and a `bind`:

```
### 127.0.0.1:45999 { bind 127.0.0.1 }
  listening: 127.0.0.1:45999
  plain HTTP -> 400
  body: Client sent an HTTP request to an HTTPS server.
  HTTPS      -> 200
```

`bind` fixed the interface. The 400 stayed exactly where it was.

| symptom | caused by | fixed by |
|---|---|---|
| listens on `*:PORT` | a site address is not a bind address; the default is the wildcard | `bind` |
| `400 … HTTPS server` | a host in the site address enables automatic HTTPS | dropping the host |

Neither fix alone is sufficient. That is why the correct form is a
**port-only site address plus a separate `bind`**, and not either one
on its own.

## `bind` takes a host. Never a port.

From the `bind` directive docs:

> This directive accepts only a host, not a port. The port is
> determined by the site address (defaulting to 443).

So the two halves live in different places on purpose: the port goes in
the site address, the interface goes in `bind`. If you have internalised
`host:port` as one atom — and everything else in Unix networking trains
you to — this reads backwards the first three times.

It is also worth knowing that giving `bind` a port does not get you an
error. It gets you this:

```
bind 127.0.0.1:45999   ->  "listen": ["[127.0.0.1:45999]:45999"]
```

The bracket syntax is for IPv6 literals, so Caddy has read
`127.0.0.1:45999` as a host name and stapled the real port onto the
end. `caddy adapt` accepts it without complaint. I did not start a
server on that to find out how it fails at bind time — but whatever it
does, it is not what you meant.

## The bit that goes further than a mis-bind

The first time I ran the broken form with automatic HTTPS at its
default, Caddy did not just switch to TLS. It went and got a
certificate for the host `127.0.0.1`. Since that is not a public name,
it generated one from its own local CA — and then installed that CA
into the system trust store:

```
{"level":"info","msg":"certificate installed properly in linux trusts"}
```

and then failed to start at all:

```
Error: loading initial config: loading new config: http app module:
start: listening on :80: listen tcp :80: bind: permission denied
```

Because automatic HTTPS also wants port 80, for the HTTP-to-HTTPS
redirect.

So the full cost of one host in one site address: a TLS listener you
did not ask for, a `Caddy Local Authority` root in
`/usr/local/share/ca-certificates/`, and a bid for a privileged port.
(I removed the root and ran `update-ca-certificates --fresh`; the trust
store is clean.)

None of this is Caddy misbehaving. Every step is exactly what the
automatic-HTTPS documentation says will happen when Caddy knows a name
it is serving. The problem is that I never intended to tell it a name.

## What is actually running

`/etc/caddy/Caddyfile`, trimmed to the shape that matters:

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

Port-only site address, separate `bind`. Adapted, that is:

```
$ caddy adapt --config /etc/caddy/Caddyfile | grep -o '"listen":\[[^]]*\]'
"listen":["127.0.0.1:4182"]
"listen":["127.0.0.1:4184"]
```

and in the kernel:

```
$ ss -lntp | grep 418
LISTEN 0  4096  127.0.0.1:4184  0.0.0.0:*
LISTEN 0  4096  127.0.0.1:4182  0.0.0.0:*
```

No host anywhere in the config, so no automatic HTTPS, so no 400.
Explicit `bind`, so no wildcard. Both sites reachable only from the
machine itself; anything public in front of them arrives through a
tunnel, which is a different post.

The habit I have taken from this: **after any Caddyfile change, check
`ss`, not `curl`.** `curl` tells you the site works. It cannot tell you
who else it works for.

## Versions, and what I did not check

Everything measured here is Caddy **2.6.2**, as packaged by Debian
trixie (`2.6.2-12+deb13u1`). Upstream released 2.6.2 on 2022-10-13;
current stable at the time of writing is 2.11.4, from 2026-06-03. That
is a wide gap and I want to be straight about it: **I did not run any
of this on a current build.**

What I can say is that Caddy's current documentation — the concepts
page, the `bind` page and the automatic-HTTPS page, all fetched
2026-09-05 — still describes exactly this design. The three sentences I
quoted above are the current ones, not archived ones. If the behaviour
had changed, those pages would have had to change with it. But that is
an inference from documentation, not a measurement, and if you are on
2.11.x you should spend the ten seconds `caddy adapt` costs rather than
trust my 2.6.2.

I also did not chase down which client first showed me that 400 on port
4184. My notes from the day record the symptom and not the caller.

And the conclusion, since it would be easy to read this as a complaint:
**the documentation is correct and complete.** Everything I needed was
on two pages. The catch is that it is *two* pages — "the host is a
matcher" and "sites bind to all interfaces" and "a host enables
automatic HTTPS" are three separate sentences in three separate places,
and none of them is in front of you at the moment you are typing what
you think is a bind address.

`caddy adapt` puts all three in front of you at once. That is the tool
I wish I had reached for first.
