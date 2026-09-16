---
title: "My Wi-Fi came back the moment I told my Raspberry Pi it lives in America"
description: "A strong 5 GHz network on channel 161 was invisible to my Pi. Linux said the channel was allowed. The Wi-Fi chip disagreed. Switching the country to US fixed it."
date: 2026-09-06
category: tech
tags: ["wifi", "raspberry-pi", "linux", "brcmfmac", "networking"]
draft: false
---

On 26 July 2026 my Raspberry Pi stopped finding my 5 GHz Wi-Fi. Not "connected but slow" — the network simply wasn't in the scan results. The signal wasn't weak either — around -45 dBm, which in Wi-Fi terms is practically shouting. The router sat on channel 161. The Pi's country was set to India, which is where the Pi and I both live. Three scans, three times nothing.

Then I told the Pi it was in the United States. It found the network on all three scans. Same router, same channel, same day — one setting changed, and a network that didn't exist suddenly existed.

That's the whole mystery, and the answer turns out to be something most Wi-Fi troubleshooting guides never mention: **on this Pi, Linux isn't the one doing the scanning.** The Wi-Fi chip is, and it brought its own rulebook from 2023.

## A channel that was legal and invisible at the same time

Every Wi-Fi device follows a set of rules for the country it's in — its **regulatory domain**. Those rules decide which channels it may use and how loudly it may transmit. Set a device to a different country and you genuinely change which frequencies it will touch.

Channel 161 lives in a block called UNII-3: channels 149 to 165, up around 5.8 GHz. That's where my router was. With the country set to `IN`, my Pi behaved as though that entire block had been deleted from the universe:

```
country  scans that found the network
IN       0 of 3
US       3 of 3
```

Three scans each, roughly four seconds apart, because a single Wi-Fi scan is about as trustworthy as a weather forecast.

So the obvious question: is UNII-3 even allowed in India? As far as Linux is concerned, yes. The kernel's regulatory database — `wireless-regdb`, the file behind all these country rules — says this about India:

```
country IN:
  (2402 - 2482 @ 40), (30)
  (5150 - 5250 @ 80), (30)
  (5250 - 5350 @ 80), (24), DFS
  (5470 - 5725 @ 160), (24), DFS
  (5725 - 5875 @ 80), (30)
  ...
```

Channels 149 to 165 cover 5745 to 5825 MHz, which sits comfortably inside that `5725 - 5875` line. By Linux's own rulebook, my Pi was allowed to use my router's channel while set to India. It still couldn't see it.

(That entry is from the current upstream database. This Pi has `wireless-regdb` 2026.02.04 installed, but I can't decode the binary file locally, so I haven't confirmed it's byte-for-byte identical.)

## The command that sends everyone down the wrong road

This is the first thing you'll run, and it will lie to you with total confidence:

```
$ iw phy phy0 info | grep -E "57[0-9]{2}|58[0-9]{2}"
  * 5745.0 MHz [149] (20.0 dBm)
  * 5765.0 MHz [153] (20.0 dBm)
  * 5785.0 MHz [157] (20.0 dBm)
  * 5805.0 MHz [161] (20.0 dBm)
  * 5825.0 MHz [165] (20.0 dBm)
```

All five channels present. Nothing marked `disabled`, no warnings, no asterisks of doom. (That output is from the Pi as it runs today, on `US` — but India's kernel rules include those channels too, so under `IN` this list should look every bit as healthy.)

At which point you conclude the Pi is fine and go shout at your router. Completely reasonable. Completely wrong. My notes from that day put it bluntly: a channel showing up as enabled here does **not** mean this Wi-Fi chip will ever actually scan it.

## Two rulebooks, and only one of them is Linux's

Here's the command where the penny dropped:

```
$ iw reg get
global
country 98: DFS-UNSET
  (2402 - 2472 @ 40), (N/A, 30), (N/A)
  (5150 - 5250 @ 80), (N/A, 23), (N/A)
  (5250 - 5350 @ 80), (N/A, 24), (0 ms), DFS
  (5470 - 5725 @ 160), (N/A, 24), (0 ms), DFS
  (5725 - 5730 @ 5), (N/A, 24), (0 ms), DFS
  (5730 - 5850 @ 80), (N/A, 30), (N/A)
  (5850 - 5875 @ 25), (N/A, 27), (N/A),
      NO-OUTDOOR, PASSIVE-SCAN

phy#0
country 99: DFS-UNSET
  (2402 - 2482 @ 40), (6, 20), (N/A)
  (2474 - 2494 @ 20), (6, 20), (N/A)
  (5140 - 5360 @ 160), (6, 20), (N/A)
  (5460 - 5860 @ 160), (6, 20), (N/A)
```

Two blocks. Two very different things.

- **`global`** is the Linux kernel's view, built from `wireless-regdb`. This is the one `apt` updates and the one every tutorial is talking about. Precise band edges, sensible power limits, radar detection (DFS) flagged where it belongs.
- **`phy#0`** is what the **Wi-Fi device itself** reports. Compare them. Round numbers everywhere, a flat 20 dBm for everything, not a single DFS marking, and a cheerful line covering 2474–2494 MHz — that's channel 14, which realistically only Japan has ever permitted.

That second table did not come out of the Linux database. It's the chip's own private opinion about international law. Which raises the obvious follow-up: why does a Wi-Fi chip have opinions about international law?

## Because the chip, not Linux, decides what to scan

```
$ ls -l /sys/class/net/wlan0/device/driver
... -> .../bus/sdio/drivers/brcmfmac
```

The driver is `brcmfmac`, for Broadcom/Cypress chips, and those chips are **FullMAC**. That single word explains this entire post.

Wi-Fi chips come in two broad styles:

- **SoftMAC** — Linux does the thinking. It builds the scan itself, and the kernel's country rules decide which channels get scanned.
- **FullMAC** — the chip has its own little processor running its own firmware. Linux politely asks it to go scan, and the firmware decides what it's prepared to look at, using a country table baked into the firmware.

So on this Pi, Linux is the receptionist, not the manager. It passes your request along and reports back whatever the chip feels like saying.

And here's the firmware doing the deciding:

```
brcmfmac: using brcm/brcmfmac43455-sdio
          for chip BCM4345/6
brcmfmac: Firmware: BCM4345/6 wl0:
          Aug 29 2023 01:47:08
          version 7.45.265 (28bca26 CY)
```

Built **29 August 2023**. Whatever country tables live inside it are that old, and running `apt upgrade` on `wireless-regdb` doesn't touch them — they're two completely separate update paths, and only one of them was ever getting updated.

## The fix: tell the Pi it lives in America

I set the regulatory domain to `US`. On this Pi that lives in **two** places, and you want both.

The kernel command line, in `/boot/firmware/cmdline.txt`:

```
... rootwait cfg80211.ieee80211_regdom=US
```

And `/etc/modprobe.d/cfg80211.conf`:

```
options cfg80211 ieee80211_regdom=US
```

Then confirm the running kernel actually took it, rather than assuming:

```
$ cat /sys/module/cfg80211/parameters/\
ieee80211_regdom
US
```

The network turned up on 3 scans out of 3, and the Pi has stayed on `US` ever since. As I write this, on 16 September 2026, it's still sitting on channel 161:

```
$ iw dev wlan0 link
  freq: 5805.0
  signal: -52 dBm
  rx bitrate: 433.3 MBit/s
```

5805 MHz *is* channel 161 — one of the channels it couldn't see under `IN`. Going by July's scans, flipping back to India would knock this machine straight off the network.

**The price you pay.** US rules don't allow 2.4 GHz channels 12, 13 and 14, so the Pi has now switched them off:

```
* 2467.0 MHz [12] (disabled)
* 2472.0 MHz [13] (disabled)
* 2484.0 MHz [14] (disabled)
```

This Pi connects over 5 GHz, so I've never missed them. If your network happens to sit on channel 12 or 13, this "fix" just swaps one invisible network for another.

### Three things to know before you try it

- **Write it in both places.** The kernel command line *and* `/etc/modprobe.d/`. One without the other can work on some boots and not others, which is the worst kind of bug.
- **Don't trust `raspi-config`'s exit code.** On this headless Pi, `raspi-config nonint do_wifi_country <CC>` fell over with `Cant connect to display: (null)` — *after* it had already written the change to `cmdline.txt`. It looked like a failure and wasn't. Check the file and `/sys/module/cfg80211/parameters/ieee80211_regdom` instead of believing the error.
- **Don't saw off the branch you're sitting on.** This Pi's only link to the world is that Wi-Fi. Before changing the country over SSH, check that the channel you're currently connected on is allowed in the new country. Better still, schedule an automatic revert first, so a mistake costs you five minutes instead of a walk across the house with a keyboard.

## What I proved, and what I'm still guessing

I want to keep the measurements separate from the story, because most write-ups on this quietly skip that bit.

**Measured:**
- The two rulebooks disagree with each other.
- The chip's table plainly doesn't come from the Linux database.
- The firmware dates from 2023.
- Under `IN` the network was invisible (0 of 3 scans); under `US` it was there (3 of 3).
- The Pi is on channel 161 today.

**Believed, not shown:** that the firmware's country table for `IN` omits channels 149–165, and that's why those scans came back empty.

It's the most likely explanation by a distance, but "a scan found nothing" and "a table is missing a channel" are not the same statement. The experiment that would settle it: set the country back to `IN`, list the channels the chip reports, and show 5745–5825 missing even though the kernel's `IN` rules include them. Kernel says yes, chip says no, case closed.

I haven't run it. The only connection this Pi has is the Wi-Fi I'd be breaking, and getting it wrong means losing the machine. The truly conclusive version would be reading the country table straight out of the firmware blob, and I don't know how to do that on this chip — I couldn't find anyone who's published a method.

Two more things I'm explicitly *not* claiming:
- **Newer firmware:** I don't know whether more recent `firmware-brcm80211` packages fix the table.
- **Every Pi:** I don't know that all Pis behave this way. This one is a Pi 5 reporting chip `BCM4345/6` with `brcmfmac43455-sdio`. Check yours before assuming.

## Hang on — is this even legal?

I'm not a lawyer and this isn't legal advice.

What I can point at: Linux's own rules for India include 5725–5875 MHz. News coverage and policy write-ups say India has delicensed parts of the 5 GHz band, that range included, for low-power indoor use. So the thing standing between my Pi and channel 161 looks like a firmware table from 2023, not Indian law.

But I haven't read the government's official notification myself. Check the rules for your own country from the source rather than from a blog post — and yes, that includes this one.

## The bit I still can't explain

I have no idea what `country 98` and `country 99` are doing in that `iw reg get` output. They aren't real country codes. The kernel setting says `US`, the `global` table broadly looks like US rules, so *something* is mapping codes strangely somewhere between the setting, the kernel and the driver. I don't know what, and I'd rather leave an honest open question than invent a tidy answer.

If you know, please tell me. My Pi would also like to know where it lives.

---

*Observed on this Pi: Raspberry Pi 5, Debian 13, `brcmfmac43455-sdio`, chip `BCM4345/6`, firmware 7.45.265 (28bca26 CY) dated 2023-08-29, `wireless-regdb` 2026.02.04. The scan results (0/3 under `IN`, 3/3 under `US`) are from 2026-07-26. The two-table output was captured 2026-09-02 and matched again on 2026-09-16, with the Pi connected on channel 161 at -52 dBm. The claim that the firmware's `IN` table leaves out channels 149–165 is inferred, not demonstrated. 6 GHz is out of scope — this chip doesn't support it.*
