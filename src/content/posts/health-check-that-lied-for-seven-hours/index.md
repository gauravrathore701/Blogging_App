---
title: "The health check that lied for seven hours"
description: "systemd said running, my heartbeat said alive, Discord showed the bot online. For seven hours it couldn't receive a single message, because my health check tested the wrong connection."
date: 2026-09-03
category: tech
tags: ["monitoring", "discord", "systemd", "python"]
draft: false
---

For seven hours, every check I had said my Discord bot was perfectly healthy.

- **systemd**, which runs the bot on my Raspberry Pi, said `active (running)`.
- **My heartbeat file**, which the bot updates every two minutes to prove it's alive, kept getting updated.
- **Discord** showed the bot as online, green dot and all.

Meanwhile, from 06:19 that morning, the bot couldn't connect to receive a single message.

## The error nobody saw

The error was in the log the whole time. It showed up 54 times:

```
aiohttp.client_exceptions.WSServerHandshakeError: 503, message='Invalid response status', url='wss://gateway-us-east-1a.discord.gg/?v=10&encoding=json&compress=zlib-stream'
```

The first one was at 06:19:38 on 1 September (India time), and the last was at 13:20:15. That's seven hours and 37 seconds of Discord refusing to let my bot connect.

That's the number I use as the headline, because it's the one I can count. The real outage may have been a bit longer. The last time the bot successfully reconnected before this was at 04:51, and there was a short burst of the same error even earlier, at 02:48.

**What the 503 means.** A Discord bot receives messages over a **websocket**, a connection that stays open so Discord can push messages to the bot as they happen. To open one, the bot sends a request asking to switch to a websocket. Here, Discord's server answered that request with **503**, which means "service unavailable", and never opened the connection.

That detail matters if you're searching for this error. Discord has its own list of error codes in the 4000s, but those only apply once a connection is open. This one failed before that, so none of Discord's error-code docs will help. The Python library underneath (aiohttp) raises `WSServerHandshakeError` whenever the server says anything other than "OK, switching to websocket".

It wasn't my Pi, either. The system log shows the Pi stayed up the whole time, with no reboot inside the window. The problem was on Discord's side.

## Three checks, three different reasons they lied

### 1. The heartbeat tested the wrong connection

Here's my heartbeat code from before the fix. Read the comment at the top:

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

Every two minutes, it asks Discord for the bot's own user profile. If that works, it updates the heartbeat file.

The comment says this proves the **gateway** is alive. The gateway is the websocket, the connection messages actually arrive on. But `fetch_user()` doesn't use the gateway. It's a normal one-off web request to Discord's **REST API**, a completely separate service at `discord.com/api`.

Think of it like checking whether your phone line works by sending an email. The email going through tells you nothing about the phone.

That morning, the two services failed separately. The API kept working the whole time, and the websocket wouldn't open. So the heartbeat kept succeeding and updating the file.

There isn't a single `[heartbeat] check failed:` line in the log for those seven hours. The check never complained once, and that silence is what this post is about.

### 2. The watchdog trusted the heartbeat

I also have a watchdog: a small script that systemd runs every five minutes. If the heartbeat file is more than 10 minutes old, it restarts the bot.

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

It ran every five minutes for seven hours and did nothing, because the file was always fresh. It was being refreshed by a check that couldn't fail.

The watchdog only writes to the log when it restarts something. Its log for that day is completely empty (`-- No entries --`), so it never acted once.

### 3. "Restart=always" never kicked in

The bot's systemd service has `Restart=always` and `RestartSec=15`. That sounds like a safety net, but it only restarts the bot when the program **exits** or crashes. My bot never exited.

discord.py, the Python library the bot uses, catches this error and quietly keeps retrying. I checked the source for version 2.7.1. `Client.connect()` has a loop that catches `aiohttp.ClientError`, which this error is a type of, and waits a bit before trying again.

So the program looked perfectly fine to systemd. If you think `Restart=always` means "systemd will notice when my app stops working", this is the kind of day that proves otherwise.

### The waiting got longer and longer

Each time a retry fails, discord.py waits longer before trying again. That's called **exponential backoff**, and it's normally good manners, since it stops every client from hammering a struggling server at once. Here's what it looked like in my log:

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

Within the first hour, the bot was waiting over 16 minutes between attempts. Even if Discord had recovered, my bot could easily have been asleep for another quarter of an hour before noticing.

### And Discord still showed the bot as online

This one surprised me most. The green dot next to the bot's name comes from its websocket session. My best explanation is that the connection never closed cleanly on Discord's side, so Discord kept showing the last status it knew: online. The signal people actually look at was the least trustworthy of the three.

### How it actually ended

Nothing I built ended the outage. A few minutes after the last 503, the Pi itself restarted. That wasn't the watchdog, which logged nothing that day. After the restart, the 503s stopped.

## Discord's status page was green too

This part changed how I think about status pages.

Discord's status page lists its services separately. This is from `discordstatus.com/api/v2/components.json`, fetched 2026-09-02:

```
'API'                 status=operational
'Gateway'             status=operational
'Media Proxy'         status=operational
'Voice'               status=operational
```

`API` and `Gateway` are listed as separate items. So Discord itself treats them as things that can break independently. Their incident history from the previous four months has both kinds: problems with only the Gateway, and problems with only the API.

Here's the incident closest to my outage, from the same status API:

```
name:      Some servers and other services (voice calls, activities)
           not available for some users
impact:    major
resolved:  2026-08-31T17:49:17 -0700
components: []
```

That resolved time is **06:19:17 on 1 September**, India time. My first 503 of the long run was at **06:19:38**, 21 seconds later.

I want to be careful here. That's a timing coincidence and nothing more. Discord didn't publish a write-up explaining the incident, and nothing links it to the gateway. I'm not saying their fix caused my outage.

What I *am* pointing out is the last line, `components: []`. The incident wasn't attached to any service at all. So even a script checking the status page for "Gateway is not operational" would have seen all green for the entire seven hours.

If your backup plan is "check the status page", someone at the company has to update the status page first.

## The fix: check the connection that matters

The fix is to check the websocket itself, not the API:

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

The heartbeat only runs if that check passes:

```python
if not gateway_alive():
    raise RuntimeError("gateway websocket down (REST may still be up)")
await client.fetch_user(client.user.id)
```

It asks three questions, in order:

1. Has the bot been shut down?
2. Is there a websocket, and is it open?
3. Does the bot have a real latency reading?

I checked the first two against discord.py 2.7.1's source. `ws.open` is literally `return not self.socket.closed`.

The third check needs a little explanation. Here's `client.latency` in discord.py:

```python
@property
def latency(self) -> float:
    ws = self.ws
    return float('nan') if not ws else ws.latency
```

With no websocket, latency is `NaN`, which stands for "not a number". NaN has one odd property: it's the only value that isn't equal to itself. So `latency == latency` is `False` exactly when there's no live websocket, and you don't need to import anything to test it. It's a small trick, and I haven't seen it written down anywhere for discord.py, so here it is.

## What the fix costs

Now, if Discord's gateway goes down for a long time, the heartbeat stops and the file goes stale. The watchdog then restarts the bot, and it keeps restarting it every few minutes until the gateway comes back. That's noisy, and pretending otherwise would be dishonest.

But that's also the point. Look at the backoff log again: within an hour, the bot was waiting 16 minutes between attempts. A fresh restart starts that waiting over from the beginning. The first retry in the log above came after under two seconds. When the gateway comes back, that's the difference between reconnecting almost right away and reconnecting whenever a 16-minute nap happens to end.

On paper, the watchdog should notice a dead gateway within about 10 to 15 minutes. The file has to be 10 minutes old, and the watchdog only checks every 5. I haven't actually seen that happen yet. The log I still have goes back to 11 September, and since then there hasn't been a single 503 error or a single watchdog restart. The fix simply hasn't met a real outage.

## The general rule

**Health-check the connection your work actually comes through.**

Not just any connection, and not the one that's easiest to test. Check the one that, if it stops, means your app isn't doing its job. My bot's work arrives over a websocket, but my check tested a web API. The gap between those two was seven hours wide.

This goes well beyond Discord:

- a Kafka consumer whose health check asks the broker's admin API
- an MQTT client that pings the broker's web dashboard
- a trading app that checks the REST price endpoint while its live market-data socket sits dead

Every time, there's a cheap, convenient signal right next to the real one, and the cheap one is what gets wired up.

Most advice about health checks is written for web servers that answer requests. Almost none of it covers an app that opens a long-lived connection **out** to someone else's service and waits for work to arrive. That's what every chat bot, feed reader and queue worker actually is. For those apps, "is the program running?" and "is work actually arriving?" are very different questions.

Three green lights and no messages is what that difference looks like from the outside.
