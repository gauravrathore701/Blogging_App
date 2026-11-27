---
title: "My Pi went dark four times in five days, and never logged a shutdown"
description: "No shutdown lines, a clock that said 1970, and a journal whose new boots start before the old ones end. Six read-only checks that tell a power loss from a crash or a WiFi drop."
date: 2026-11-26
category: tech
tags: ["raspberry-pi", "self-hosting", "systemd", "debugging", "failover"]
draft: false
---

Between 19 and 23 November my Raspberry Pi disappeared four times, and each time it was the power. Three of those times, the Oracle VM I built as its [failover twin](/blog/posts/pi-failover-twin-part-2-pulling-the-plug-on-purpose/) noticed and took over. The fourth was too short for it to bother.

The Pi itself had nothing to say about any of them. No shutdown, no error, no warning. Its logs just stop, and then a new boot starts.

When a headless Pi drops off the network, the first suspect is usually WiFi. It wasn't WiFi. Here are the checks that show it. All of them are read-only and take about a minute.

## Check 1: five boots, zero reboots

```
$ journalctl --list-boots
IDX  FIRST ENTRY                  LAST ENTRY
 -4  Tue 2026-11-17 15:23:01 IST  Thu 2026-11-19 15:09:01 IST
 -3  Thu 2026-11-19 15:07:31 IST  Sat 2026-11-21 09:03:56 IST
 -2  Sat 2026-11-21 09:00:58 IST  Sat 2026-11-21 15:32:03 IST
 -1  Sat 2026-11-21 15:30:20 IST  Mon 2026-11-23 21:54:43 IST
  0  Mon 2026-11-23 21:51:43 IST  Thu 2026-11-26 10:01:23 IST
```

(This is this morning's output; I cut the boot ID column, and the peer names and relay number in Check 2's last lines.) Four new boots in five days, and I didn't reboot it once.

Look at the times, though. Boot -3 *starts* at 15:07:31, a minute and a half before boot -4 *ends* at 15:09:01. Every boot here starts before the previous one ended. Hold that thought; it's the most interesting part of this post.

## Check 2: no boot ended cleanly

A clean shutdown or reboot leaves a trail in the journal: systemd reaching `shutdown.target`, "System is rebooting", the journal itself stopping. I searched each of the four old boots for those lines:

```
$ journalctl -b -1 | grep -iE \
  'Reached target.*(Shutdown|Reboot|Power-Off)|'\
'System is (rebooting|powering)|'\
'systemd-shutdown|Journal stopped'
$
```

Nothing, for all four. And the last lines are completely ordinary. Here is how boot -1 ended:

```
21:54:18 python3[1273]: renewed
21:54:22 tailscaled[1040]: magicsock: derp-N does not know about peer [...], removing route
21:54:28 tailscaled[1040]: magicsock: derp-N does not know about peer [...], removing route
21:54:33 tailscaled[1040]: magicsock: derp-N does not know about peer [...], removing route
21:54:38 tailscaled[1040]: magicsock: derp-N does not know about peer [...], removing route
21:54:43 tailscaled[1040]: magicsock: derp-N does not know about peer [...], removing route
```

The failover lock daemon renewing its lock, Tailscale chattering every five seconds, and then silence. Nothing was shutting down. Something stopped the whole machine between one line and the next.

That still leaves two suspects: the power went, or the kernel froze hard and something reset the board. The next check splits them.

## Check 3: the clock woke up in 1970

```
$ journalctl -b 0 -k | \
  grep 'setting system clock'
rpi-rtc soc@107c000000:rpi_rtc: setting system clock to 1970-01-01T00:00:15 UTC (15)
```

The Pi 5 has a real-time clock on the board, and the kernel reads it at boot to set the time. It can run from a small battery on the J5 connector, which mine doesn't have. With no battery, the clock only runs while the board has power.

So "1970, 15 seconds" means the clock had been counting for 15 seconds, from zero. It started when the power came back. All four new boots have exactly this line. The 15 seconds even makes sense: the kernel logged it 1.6 seconds after it started (the journal shows 7–8 s, but that's when journald read it), so roughly 13 seconds went to firmware and the bootloader first.

A frozen kernel that gets reset with the power still on should not lose the clock, because nothing ever cut its supply. I can't show you that contrast from this journal, because the clean reboot from my 12 November failover drill has already rotated out. So treat that part as reasoning rather than a measurement. A clock that starts from zero, though, means the clock had no power.

## Why the journal doesn't say 1970

If the clock started at 1970, why is boot 0's first line stamped 21:51:43 on 23 November, and not 1970?

Because systemd fixes it before the journal starts. From `man systemd`, under *System clock epoch*: when it starts, systemd moves the clock forward to the latest of three times: its own build time, the modification time of `/usr/lib/clock-epoch`, and the modification time of `/var/lib/systemd/timesync/clock`. That last file is touched by `systemd-timesyncd` on every successful sync, and every 60 seconds (`SaveIntervalSec=`) when there hasn't been a recent sync. If that file can't be read yet when systemd starts, `systemd-timesyncd` makes the same jump itself as soon as it starts.

So every early line of a new boot is stamped with *the last time the clock was saved*, a few minutes before the power went. The real time only arrives when NTP answers. Before that, the Pi lives in the past. That's why each boot in Check 1 seems to start before the last one ended.

My own per-minute monitor shows it too. Its log runs backwards across the 23 November cut:

```
{"ts":"2026-11-23 21:53","k":"sys","load":0.2,  ...}
{"ts":"2026-11-23 21:54","k":"sys","load":0.24, ...}
{"ts":"2026-11-23 21:52","k":"sys","load":5.02, ...}   <- new boot, old clock
{"ts":"2026-11-23 21:57","k":"sys","load":6.7,  ...}   <- NTP has answered
```

The load of 5.02 gives it away: that's a Pi that has just booted, writing a timestamp about four minutes in the past.

If you work out how long an outage lasted from the journal's timestamps, you will get it wrong.

## Check 4: NTP minus uptime is the real boot time

The monotonic clock doesn't care about any of this. It counts seconds since the kernel started. So take the first line where timesyncd reaches a time server. That line carries the correct wall time, because it's written after the clock jump, and also its monotonic seconds. Subtract one from the other, and you get the real moment the kernel started.

```
$ journalctl -b 0 -u systemd-timesyncd \
  -o short-monotonic | grep -m1 Contacted
[   38.798907] systemd-timesyncd[418]: Contacted time server ...
$ journalctl -b 0 -u systemd-timesyncd | \
  grep -m1 Contacted
Nov 23 21:56:37 systemd-timesyncd[418]: Contacted time server ...
```

21:56:37 minus 38.8 seconds is 21:55:58. `uptime -s` says `2026-11-23 21:55:58`, so the method checks out. Doing the same for all four:

```
outage      last line   kernel up   dark
19 Nov      15:09:01    15:36:02    27:01
21 Nov am   09:03:56    09:06:58     3:02
21 Nov pm   15:32:03    15:36:45     4:42
23 Nov      21:54:43    21:55:58     1:15
```

"Dark" runs from the last log line to the kernel starting again, so it includes the roughly 13 seconds of firmware boot. The last line can also come up to a minute before the real cut, because the Pi doesn't log every second. Read these as close, not exact.

## Check 5: the supply never sagged

```
$ vcgencmd get_throttled
throttled=0x0
```

On a Pi, bit 16 (`0x10000`) of this value means "under-voltage has occurred" since boot. A weak supply or a bad cable usually sets it long before anything dies. My monitor has read this value every minute since 19 November, which was 10,454 samples as of this morning, and every one of them is `0x0`. That includes the minutes just before each cut.

One limit, though. That bit lives in the Pi's memory, and it's lost with the power. If a sag happened in the last seconds before a cut, no sample would catch it. What `0x0` does rule out is a supply that had been struggling for a while. It wasn't browning out; it was fine, and then it was off.

## Check 6: the VM kept the real clock

The Pi's own clock can't be trusted across a cut, so it helps to have a log from somewhere else. The failover VM keeps one. Its job is to notice when the Pi goes quiet, and it never rebooted during this week:

```
19 Nov 15:12:41  vm -> leader: Pi silent 3 min, took epoch 18
19 Nov 15:39:34  vm -> standby: pi holds epoch 19
21 Nov 09:07:53  vm -> leader: Pi silent 4 min, took epoch 20
21 Nov 09:10:57  vm -> standby: pi holds epoch 21
21 Nov 15:36:05  vm -> leader: Pi silent 4 min, took epoch 22
21 Nov 15:39:09  vm -> standby: pi holds epoch 23
```

Three takeovers, which line up with the first three rows of the table. The fourth was short enough that the Pi renewed its lock about two minutes after the last one, under the VM's three-minute threshold, so the VM sat it out. The last renewal before the cut was at 21:54:18 and the first one after it at 21:56:19 in real time. The journal stamps that one 21:51:57, from the old clock. Its log for that night is just `standby`, once a minute.

When I wrote [part 2](/blog/posts/pi-failover-twin-part-2-pulling-the-plug-on-purpose/), the VM had taken over nine times that I hadn't planned, and I left the causes for "a different post". This is that post. Three of those nine are now explained: the Pi lost power.

## What this doesn't tell me

It doesn't tell me *where* the power went. The Pi can't tell a power cut to the house from a loose plug or a dying power supply. From the inside, all three look identical: the power goes and comes back. The 6 November outage, which my notes put at about 42 minutes with the same 1970 clock, looked exactly the same. For these four, I only know the Pi had no power.

It does settle what *not* to fix. Not WiFi power-saving, not the WiFi country setting, not the router. The fix is on the power side, a UPS in front of the Pi, and the failover twin is what covers the gap until then. A coin cell on J5 would give me the right time after a cut, but it wouldn't keep the Pi up.

## The one-minute checklist

When a headless Pi "drops off the network":

- `journalctl --list-boots`. More boots than you did means it restarted on its own.
- `journalctl -b -1 -n 20`. No shutdown lines and an ordinary last line means it stopped abruptly.
- `journalctl -b 0 -k | grep 'setting system clock'`. A clock that starts at 1970 on a Pi 5 with no battery means the board lost power.
- Don't trust the journal's times right after boot. They come from the last saved clock, not the real time. Get the real boot time from NTP sync time minus monotonic seconds, or from `uptime -s`.
- `vcgencmd get_throttled`. `0x0` rules out a supply that had been sagging, but not a sudden cut.
- If you have a second machine, its log is the only clock that kept running.
