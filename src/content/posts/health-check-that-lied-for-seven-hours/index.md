---
title: "The health check that lied for seven hours"
description: "systemd said active. The heartbeat file was 40 seconds old. Discord showed the bot online. It had not processed a message since 06:19 — because the health check tested REST, not the websocket."
date: 2026-09-03
category: tech
tags: ["monitoring", "discord", "systemd", "python"]
draft: true
---

For seven hours my Discord bot was, according to every instrument I
owned, completely healthy.

systemd said `active (running)`. My heartbeat file was 40 seconds old.
Discord's own client showed the bot **online**, green dot and all.

It had not processed a message since 06:19.

## The error nobody saw

It was in the journal the whole time, 54 times:

```
aiohttp.client_exceptions.WSServerHandshakeError: 503, message='Invalid response status', url='wss://gateway-us-east-1a.discord.gg/?v=10&encoding=json&compress=zlib-stream'
```

First one at `Sep 01 06:19:38` IST, last at `Sep 01 13:20:15` — seven
hours and thirty-seven seconds of a gateway refusing to open a websocket.
(That is the window in which handshakes were being refused. I use it as
the headline number because it is the one I can count; the last
successful session resumed earlier still, so "unreachable" was arguably
longer.)

That 503 is worth a moment. It is not a Discord close code — none of the
4000-series documentation applies, which is why searching close codes
gets you nowhere. It is an HTTP rejection of the WebSocket **upgrade
request**, before a single Discord opcode is exchanged. aiohttp raises
`WSServerHandshakeError` when the upgrade response is not `101`.

The host never rebooted and never lost network. `journalctl --list-boots`
shows one unbroken boot spanning the entire window.

## Three instruments, three different reasons for lying

**The heartbeat proved the wrong thing.** Here is the pre-fix loop, and
the docstring is the confession:

```python
async def heartbeat_loop():
    """Background task: prove the gateway is really alive, not just 'active' to
    systemd. ..."""
    while True:
        try:
            await client.fetch_user(client.user.id)
            with open(HEARTBEAT_FILE, "w") as f:
                f.write(str(int(time.time())))
        except Exception as e:
            print(f"[heartbeat] check failed: {e}", flush=True)
        await asyncio.sleep(HEARTBEAT_INTERVAL)
```

`client.fetch_user()` is a **REST** call to `discord.com/api`. The
docstring claims it proves the gateway is alive. It proves the API is
alive. Those are different services and they failed independently that
morning — REST answered every one of those calls perfectly, all seven
hours, while the websocket that actually carries messages was refusing to
open.

There is not a single `[heartbeat] check failed:` line in the journal for
that window. The check never complained once. That silence is the whole
post.

**The watchdog was fed by the heartbeat.** A timer runs every five
minutes and restarts the unit if the file goes stale:

```bash
if [ -f "$HB" ]; then
    age=$(( now - $(stat -c %Y "$HB") ))
    [ "$age" -lt "$MAX_STALE" ] && exit 0
    reason="heartbeat stale ${age}s"
else
    reason="heartbeat file missing"
fi
logger -t discord-claude-watchdog "$reason -> restarting $UNIT"
```

It ticked every five minutes for seven hours and took no action on any
tick, because the file it reads was being refreshed by a check that could
not fail. `journalctl -t discord-claude-watchdog --since "2026-09-01"`
returns `-- No entries --`, and since the script only logs when it acts,
an empty log is proof it did nothing.

**`Restart=always` never fired.** The unit has `Restart=always` and
`RestartSec=15`. Neither mattered: systemd's restart policy acts on
process *exit*, and the process never exited. discord.py's
`Client.connect()` catches the handshake error and loops on an internal
backoff — `WSServerHandshakeError` subclasses `aiohttp.ClientError`,
which is right there in the `except` tuple, and the loop ends in
`retry = backoff.delay()`. If you believe `Restart=always` is a liveness
guarantee, this is the shape of the day that teaches you otherwise.

And that backoff is worth seeing, because it explains the long tail even
after Discord recovered:

```
Sep 01 06:19:38  Attempting a reconnect in 1.87s
Sep 01 06:19:42  Attempting a reconnect in 12.04s
Sep 01 06:20:08  Attempting a reconnect in 26.75s
Sep 01 06:20:35  Attempting a reconnect in 241.26s
Sep 01 06:24:37  Attempting a reconnect in 288.73s
Sep 01 06:29:26  Attempting a reconnect in 920.31s
Sep 01 07:01:31  Attempting a reconnect in 995.75s
Sep 01 07:18:08  Attempting a reconnect in 802.09s
```

Peak sleep: sixteen and a half minutes. A well-behaved client backing off
politely from a service that came back ten minutes ago.

**And the bot still showed online.** Presence is owned by the gateway
session. A degraded cluster never processed a clean session close, so the
last-known presence simply stuck. The most user-visible signal of all was
the least trustworthy.

## The vendor's status page was green too

This is the part that changed how I think about vendor status pages.

Discord's own component list models these as separate services. From
`discordstatus.com/api/v2/components.json`, fetched 2026-09-02:

```
'API'                 status=operational
'Gateway'             status=operational
'Media Proxy'         status=operational
'Voice'               status=operational
```

Separate `API` and `Gateway` components. That is the vendor conceding the
premise: they can be degraded independently, by design. Their incident
history has both Gateway-only and API-only entries in the last four
months.

The nearest incident to my outage, from the same API:

```
name:      Some servers and other services (voice calls, activities)
           not available for some users
impact:    major
resolved:  2026-08-31T17:49:17 -0700
components: []
```

That resolution time is **2026-09-01 06:19:17 IST**. My first 503 of the
sustained run was **06:19:38 IST** — twenty-one seconds later.

I want to be careful here: that is a timing correlation and nothing more.
Discord published no postmortem and there is no component tag to connect
it to. I am not claiming their fix caused my outage.

What I *am* claiming is the second detail: the incident was filed against
**no component at all**. Even a robot polling `components.json` for
`Gateway != operational` would have seen a perfectly green board for the
entire seven hours. If your fallback plan is "check the status page", the
status page has to be told before it can tell you.

## The fix is nine lines

Check the socket, not the API:

```python
def gateway_alive() -> bool:
    if client.is_closed():
        return False
    ws = getattr(client, "ws", None)
    if ws is None or not ws.open:
        return False
    latency = client.latency
    return latency == latency  # NaN != NaN
```

and gate the heartbeat on it:

```python
if not gateway_alive():
    raise RuntimeError("gateway websocket down (REST may still be up)")
await client.fetch_user(client.user.id)
```

Both checks are library-verified rather than folklore. In discord.py
2.7.1, `DiscordWebSocket.open` is `return not self.socket.closed`. And
`Client.latency`:

```python
@property
def latency(self) -> float:
    ws = self.ws
    return float('nan') if not ws else ws.latency
```

So `latency == latency` is a NaN test that needs no import, and it is
False in exactly the case you care about: no live websocket. It is a
small trick and I have not seen it written down anywhere for discord.py,
so: there it is.

## What the fix costs

During a long Discord-side outage, the heartbeat now correctly goes
stale, so the watchdog now restarts the unit roughly every five to six
minutes for the duration. That is a real cost and pretending otherwise
would make this post dishonest.

It is also the point. Look at the backoff ladder again — by hour two the
client is sleeping sixteen minutes between attempts. A restart resets
that to under two seconds. When the gateway comes back, the difference
between reconnecting in seconds and reconnecting whenever a
sixteen-minute nap happens to end is the entire recovery time.

The design intent is a tail of about ten to twelve minutes: up to ten for
the heartbeat to age past the threshold, plus a restart. I have not
observed that yet, because the fixed build has not met a real gateway
outage. It has been running clean since 2026-09-02 08:35 IST.

## The general rule

**Health-check the transport that carries your work.**

Not a transport. Not the one that is easiest to call. The one that, if it
stops, means you are not doing your job. My bot's work arrives over a
websocket; my check called a REST endpoint; the gap between those two
things was seven hours wide.

This generalises past Discord. A Kafka consumer whose health check hits
the broker's admin API. An MQTT client that pings the broker's HTTP
dashboard. An exchange feed that checks the REST price endpoint while its
market-data socket sits dead. In every case there is a cheap, convenient
signal next to the real one, and the cheap one is the one that gets
wired up.

The generic advice about health checks is mostly written for
request-response services — liveness and readiness probes, shallow versus
deep. Almost none of it addresses a long-lived **outbound** client
connection, which is what every chat bot, feed consumer and queue worker
actually is. For those, "is the process up" and "is the work flowing" are
not close to the same question.

Three green lights and no messages is what that gap looks like from the
outside.
