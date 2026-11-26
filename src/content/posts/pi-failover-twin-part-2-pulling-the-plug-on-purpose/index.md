---
title: "Building a failover twin for my Raspberry Pi, part 2: pulling the plug on purpose"
description: "A leader lock in a Discord message, three timers, and two WiFi-off drills. The Oracle VM took over in under four minutes, and the first hand-back had both machines in charge."
date: 2026-11-25
category: tech
tags: ["self-hosting", "raspberry-pi", "oracle-cloud", "failover", "discord"]
draft: false
---

At 23:29:53 on 11 November I turned off my Raspberry Pi's WiFi on purpose. Three minutes and 24 seconds later my Discord bot was back online, running on a free Oracle Cloud VM instead.

That was the first drill. It passed, with one bug: when the Pi came back, both machines spent 33 seconds believing they were in charge.

[Part 1](/blog/posts/pi-failover-twin-part-1-a-standby-that-does-nothing/) built the twin: a complete copy of the Pi that was not allowed to run anything. This part is what decides who runs, and what happened when I tested it.

## The lock is a Discord message

Two machines need to agree on one leader. That needs something both can see and that neither of them owns. I already had one: Discord. The bot lives there, and both machines can reach it.

So the lock is a single message the bot posts in a private channel. Today it reads (time trimmed):

```
leader=pi epoch=23 renewed=…
```

The leader edits that message every minute. The epoch only goes up. Whoever takes over writes epoch + 1, waits 10 seconds, and reads it back. If the message still says their name, they won.

How old the lock is comes from Discord's clocks, not mine: the message's edit time against the `Date` header of the response. The Pi has no battery-backed clock. After a power cut it wakes up thinking it's 1970, and a lock check that trusted the Pi's clock would be useless in exactly the moment it matters.

## 90 before 180: the order that matters

The whole daemon is 176 lines of Python, one copy on each machine. It hangs on one line:

```python
TICK, STALE, SELF_DEMOTE, CONFIRM, SYNC_CAP = 60, 180, 90, 10, 600
```

- **Every 60 seconds** each side checks the lock.
- **If the leader can't reach the lock for 90 seconds,** it demotes itself.
- **If the lock is more than 180 seconds old,** the VM claims it.
- **When the Pi comes back,** it waits for Syncthing to finish (at most 10 minutes) and then takes the lock back.

The important part is that 90 is smaller than 180. A Pi that has lost its network can't tell "Discord is down" from "I'm down". So it steps back to standby before the VM is even allowed to take over. If it then turns out the Pi was fine, the worst case is that nobody leads for a bit. The alternative is two leaders.

That night the numbers started out as 240 and 300. I asked for a 3-minute takeover, so they became 90 and 180, committed at 23:27, two minutes before the first drill.

## "Am I the leader?" is one file

Part 1's rule was that every job asks "am I the leader?" before doing anything. The daemon writes the answer to `/run/failover/role`, and the check is a four-line script:

```sh
#!/bin/sh
# usage: leader-run <cmd...>   — runs cmd only on the current failover leader
[ "$(cat /run/failover/role 2>/dev/null)" = leader ] || exit 0
exec "$@"
```

Every scheduled job that posts somewhere got `leader-run` in front of it, five lines in the Pi's crontab that night. The VM got the same five. The bot checks the same file before answering a message, and stays silent unless it says `leader`.

When the VM wins, `promote.sh` starts the services in order: a small service the bot uses, the reminders, the Cloudflare tunnel, and the bot last, so everything it calls is already up. `demote.sh` stops them in reverse.

## Drill 1: WiFi off for ten minutes

My pass mark from the plan was "VM leads in under 4 minutes, bot replies, one post". Here's how it went, from my notes and the VM's log:

```
23:29:53  Pi WiFi off
23:31:37  Pi demotes itself
23:33:13  VM: Pi silent 3 min, took epoch 2
23:33:17  bot online on the VM
23:39:53  Pi WiFi back
23:40:48  Pi reclaims, epoch 3
23:41:21  VM finishes demoting
```

The takeover worked. The Pi stepped down 1 minute 44 seconds after losing its network, and the VM took the lock on its first check after the lock passed 3 minutes old.

The hand-back did not. Between 23:40:48 and 23:41:21 both machines had `leader` in their role file. Nobody wrote to the bot in those 33 seconds, so nothing got answered twice, but that was luck.

The cause is the 60-second tick. The Pi took the lock back and led straight away. The VM only reads the lock once a minute, so it carried on leading until its next check.

The fix is one line plus a comment, committed at 23:44:

```python
# VM only notices on its next tick; lead after it has demoted (drill 1: 33 s overlap).
time.sleep(TICK + 15)
```

After winning the lock, the Pi now waits 75 seconds before leading. That's one full VM tick plus some margin. The trade is deliberate: for about a minute nobody answers, instead of two machines answering.

## Hand-back made a mess of files too

Drill 1 left 10 Syncthing conflict files on the VM. In part 1 I made the VM's folders receive-only, so it could never push anything back to the Pi. That was right while it couldn't lead. Once it can lead, it's wrong: anything the VM writes while in charge, like the bot's conversation history, would be thrown away at hand-back.

So just after midnight I switched the VM's four folders to send-receive. Before flipping them I cleaned up what the VM would have pushed back: Claude CLI state that differs per machine went into the ignore file on both sides, and the 10 conflict files were moved out of the synced folders, not deleted.

## Drill 1b: the same thing again

```
00:09:15  Pi WiFi off
00:10:41  Pi demotes itself
00:13:00  VM takes epoch 4
00:13:54  "vm test" answered by the VM bot
00:19:15  Pi WiFi back
00:19:53  Pi wins epoch 5, waits 75 s
00:20:06  VM demoted
00:21:08  Pi leads
```

This time the takeover took 3 minutes 45 seconds from cut to claim, not 3:20. The 3 minutes count from the Pi's last renewal, not from the WiFi cut, and the VM only claims on one of its 60-second ticks after that. The VM's log line says "Pi silent 4 min", which is the lock's age rounded to whole minutes.

I sent "vm test" while the VM was leading. One reply came back, from the VM. After the hand-back, that exchange was in the bot's history on the Pi, so send-receive did its job, and there were no new conflict files.

No overlap this time. The VM stopped at 00:20:06 and the Pi started leading at 00:21:08, so for 62 seconds nobody was in charge. That's the gap I chose.

## Reboots should do nothing

Two more drills that night, both about failover *not* happening:

- **VM reboot while standby:** it came back as standby with all the leader services off. That boot is still running today: `uptime -s` on the VM says 2026-11-11 23:42:38.
- **Pi reboot:** at 00:40:08 I rebooted the Pi. Its lock daemon was up 30 seconds later and renewed epoch 5 at 00:40:40. The lock was never 3 minutes old, so the VM never moved.

## What I didn't drill

Two lines in my drill list never got run: a scheduled job firing while the VM is leading, and cutting only Tailscale on the Pi (so it reaches Discord but not the VM). A fresh password login to my file share on the VM is also untested. Those are still open, and I'm not claiming they work.

## Then it started happening for real

Since that night the VM has taken over nine more times without me asking: once on 14 November, three times on the 15th, twice on the 16th, once on the 19th and twice on the 21st. Every time, the Pi took the lock back afterwards. Today the Pi holds epoch 23 and the VM is standby with the bot and the tunnel stopped.

Why the Pi kept dropping out is a different post. But the real failovers found a bug the drills couldn't.

One boot-time service on the Pi, the reminder catch-up, ran without `leader-run`. While the Pi was down, the VM was leading and writing the reminders' state file. Then the Pi booted, ran the catch-up anyway, and wrote the same file. Syncthing kept both versions, and by 21 November there were nine conflict copies of it.

No drill rebooted the Pi while the VM was leading. On 21 November the service got `leader-run` in front of it, like everything else. The conflict copies were moved out of the synced folders, and today there are none.

## The short version

- **Put the lock somewhere both sides already reach,** and measure its age with that service's clock, not yours.
- **The leader should give up before the standby is allowed to take over.** Mine is 90 seconds against 180.
- **Make the "am I the leader?" check one file and one tiny script,** so every job uses the same answer.
- **Hand-back is the hard half.** The takeover passed first time. The return had two leaders.
- **Prefer a short silence to a short double.**
- **A standby that can lead must be able to sync back,** or its work disappears at hand-back.
- **Drill the reboots too.** "Nothing should happen" is a result you have to check.
- **Real failures find what drills don't.** Mine was one boot service I forgot to gate.
