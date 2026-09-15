---
title: "My Raspberry Pi couldn't see my Wi-Fi until I told it I live in America"
description: "My Pi ignored a strong 5 GHz network on channel 161. Linux said the channel was allowed. The Wi-Fi chip had its own opinion. Switching the country code to US fixed it, and here's why."
date: 2026-09-06
category: tech
tags: ["wifi", "raspberry-pi", "linux", "brcmfmac", "networking"]
draft: true
---

On 2026-07-26, my Raspberry Pi refused to see my 5 GHz Wi-Fi network. The signal wasn't weak: about -45 dBm, which in Wi-Fi terms is practically shouting. The router was on channel 161. The Pi's country was set to India (`IN`), which is where I live, and it scanned three times and found nothing.

Then I told the Pi it was in the United States. It found the network on all three scans.

This post covers why that worked, the command that makes it look like it shouldn't matter, and what I still can't prove. Short version: on this Pi, Linux doesn't do the Wi-Fi scanning. The Wi-Fi chip does, and the chip has its own rulebook.

## The problem

Every Wi-Fi device follows a set of rules for its country, called a **regulatory domain**. The rules decide which channels it may use and how loudly it may transmit. Different countries allow different channels, so a device set to India and one set to the US may not be allowed to use the same frequencies.

Channel 161 sits in a group called UNII-3: channels 149, 153, 157, 161 and 165, around 5.8 GHz. My router lived there. With the country set to `IN`, the Pi acted as if that whole group didn't exist:

```
country  scans that found the network
IN       0 of 3
US       3 of 3
```

Three scans each, about four seconds apart, because a single Wi-Fi scan is about as reliable as a weather forecast.

Is UNII-3 even allowed in India? As far as Linux is concerned, yes. The kernel's regulatory database (`wireless-regdb`, the file behind these country rules) has this for India:

```
country IN:
  (2402 - 2482 @ 40), (30)
  (5150 - 5250 @ 80), (30)
  (5250 - 5350 @ 80), (24), DFS
  (5470 - 5725 @ 160), (24), DFS
  (5725 - 5875 @ 80), (30)
  ...
```

Channels 149 to 165 run from 5745 to 5825 MHz. That's inside the `5725 - 5875` line. So by the kernel's own rules, the Pi was allowed to use my router's channel in India, and it still couldn't see it.

(That entry comes from the current upstream database. This Pi has `wireless-regdb` 2026.02.04 installed, but I can't decode the binary file locally, so I haven't confirmed it's byte-for-byte the same.)

## What we checked

### Step 1: ask Linux which channels are allowed

This is the command everyone runs first, and it's the one that sends you the wrong way:

```
$ iw phy phy0 info | grep -E "57[0-9]{2}|58[0-9]{2}"
  * 5745.0 MHz [149] (20.0 dBm)
  * 5765.0 MHz [153] (20.0 dBm)
  * 5785.0 MHz [157] (20.0 dBm)
  * 5805.0 MHz [161] (20.0 dBm)
  * 5825.0 MHz [165] (20.0 dBm)
```

All five channels are listed, with no `disabled` and no warnings. That output is from the Pi as it's set up today, on `US`. India's kernel rules include those channels too, so under `IN` this list should look just as healthy.

So you see your channel listed, decide the Pi is fine, and go blame the router. That's a completely reasonable conclusion, and it's wrong. My notes from that day say it plainly: a channel showing as enabled here does **not** mean this Wi-Fi chip will actually scan it.

### Step 2: notice there are two rulebooks

This command is where it clicked:

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

There are two blocks, and they're not the same thing:

- **`global`** is the Linux kernel's view, built from `wireless-regdb`. This is the one `apt` updates and every tutorial talks about. It has precise band edges, proper power limits, and radar-detection (DFS) marked where it's needed.
- **`phy#0`** is what the **Wi-Fi device itself** reports. It's a much rougher table: round numbers, a flat 20 dBm everywhere, no DFS markings at all, and a line for 2474–2494 MHz. That's channel 14, which pretty much only Japan has ever allowed.

That second block didn't come from the Linux database. It's the chip's own idea of the world. Which raises a fair question: why does a Wi-Fi chip have its own opinion about the law?

### Step 3: find out who actually does the scanning

```
$ ls -l /sys/class/net/wlan0/device/driver
... -> .../bus/sdio/drivers/brcmfmac
```

The driver is `brcmfmac`, for Broadcom/Cypress Wi-Fi chips, and those chips are **FullMAC**. That one word explains the whole post.

Wi-Fi chips come in two broad flavours:

- **SoftMAC:** Linux does the thinking, including building the scan, and the kernel's country rules decide which channels get scanned.
- **FullMAC:** the chip has its own little processor running its own software (firmware). Linux politely asks it to scan, and the firmware decides what it's willing to look at, using a country table built into the firmware.

So on this Pi, Linux is more of a receptionist than a manager. It passes the request along and reports back whatever the chip says.

Here's the firmware on this board:

```
brcmfmac: using brcm/brcmfmac43455-sdio
          for chip BCM4345/6
brcmfmac: Firmware: BCM4345/6 wl0:
          Aug 29 2023 01:47:08
          version 7.45.265 (28bca26 CY)
```

It was built on **29 August 2023**. Whatever country tables are inside it are that old, and updating `wireless-regdb` with `apt` doesn't touch them. Those are two separate update paths, and only one of them was being updated.

## What fixed it

I set the regulatory domain to `US`. On this Pi, it's set in **two** places.

The kernel command line, `/boot/firmware/cmdline.txt`:

```
... rootwait cfg80211.ieee80211_regdom=US
```

And `/etc/modprobe.d/cfg80211.conf`:

```
options cfg80211 ieee80211_regdom=US
```

Then I checked that the running kernel actually picked it up:

```
$ cat /sys/module/cfg80211/parameters/\
ieee80211_regdom
US
```

The network showed up on 3 scans out of 3, and the Pi has stayed on `US` ever since. As I write this, on 2026-09-14, the Pi is connected on channel 161:

```
$ iw dev wlan0 link
  freq: 5805.0
  signal: -54 dBm
```

5805 MHz is channel 161, one of the channels it couldn't see under `IN`. Going by July's scans, switching back to `IN` would knock this Pi off the network.

**The trade-off.** The US rules don't allow 2.4 GHz channels 12, 13 and 14, so those are now switched off:

```
* 2467.0 MHz [12] (disabled)
* 2472.0 MHz [13] (disabled)
* 2484.0 MHz [14] (disabled)
```

The Pi connects over 5 GHz, so I haven't missed them. If your network lives on channel 12 or 13, this fix would swap one missing network for another.

### Tips if you try this

- **Set it in both places.** The kernel command line and `/etc/modprobe.d/`. One without the other can work on some boots and not others.
- **Don't trust `raspi-config`'s exit code.** On this headless Pi (no screen attached), `raspi-config nonint do_wifi_country <CC>` failed with `Cant connect to display: (null)`, but it had **already written** the change to `cmdline.txt` before failing. Check the file and `/sys/module/cfg80211/parameters/ieee80211_regdom` rather than trusting the error.
- **Don't cut the branch you're sitting on.** This Pi's only network connection is Wi-Fi. Before changing the country remotely, make sure the network you're connected to right now is on a channel the new country allows. Better still, schedule an automatic undo before making the change, so a mistake costs you five minutes instead of a walk to the Pi with a keyboard.

## What I haven't proved

I want to keep what I measured separate from what I believe, because most write-ups on this skip that step.

**What I measured:**
- The two rulebooks disagree.
- The chip's table clearly doesn't come from the Linux database.
- The firmware is from 2023.
- Under `IN` the network was invisible (0 of 3 scans), and under `US` it was visible (3 of 3).
- The Pi is on channel 161 today.

**What I believe but haven't shown:** that the firmware's country table for `IN` leaves out channels 149–165, and that's why the scans came back empty.

That's the most likely explanation, but a scan that finds nothing and a table that's missing a channel are different things. The test that would settle it: set the country to `IN`, list the channels the chip reports, and show 5745–5825 missing even though the kernel's own `IN` rules include them. Kernel says yes, chip says no, therefore it's the firmware.

I haven't run it. This Pi's only connection is the Wi-Fi I'd be breaking, so getting it wrong means losing the machine. The really conclusive result would be reading the country table straight out of the firmware file, and I don't know how to do that on this chip. I couldn't find anyone who has published a way.

Two more things I'm not claiming:
- **Newer firmware:** I don't know whether newer `firmware-brcm80211` packages fix the table.
- **Other Pis:** I don't know whether every Pi behaves the same. This Pi 5 reports chip `BCM4345/6` with `brcmfmac43455-sdio` firmware. Check yours before assuming it matches.

## Is this legal?

I'm not a lawyer, and this isn't legal advice.

Here's what I can point to. Linux's own rules for India include 5725–5875 MHz. News coverage and policy write-ups say India has delicensed parts of the 5 GHz band, including that range, for low-power indoor use. So the thing blocking channel 161 seems to be a firmware table from 2023, not Indian law.

But I haven't read the government's official notification myself. So check the rules for your own country from the source, not from a blog post, and that includes this one.

## One mystery left

I can't explain `country 98` and `country 99` in that `iw reg get` output. Those aren't real country codes. The kernel setting says `US`, and the `global` table looks roughly like US rules, so something is mapping codes strangely between the setting, the kernel and the driver. I don't know what. I'd rather leave it as an open question than make up a neat answer.

If you know, please tell me. My Pi would like to know where it lives too.

---

*Observed on this Pi: Raspberry Pi 5, Debian 13, `brcmfmac43455-sdio`, chip `BCM4345/6`, firmware 7.45.265 (28bca26 CY) dated 2023-08-29, `wireless-regdb` 2026.02.04. The scan results (0/3 under `IN`, 3/3 under `US`) are from 2026-07-26. The two-table output was captured 2026-09-02 and matched again 2026-09-14, when the Pi was connected on channel 161. The claim that the firmware's `IN` table leaves out channels 149–165 is inferred, not demonstrated. 6 GHz is out of scope, because this Wi-Fi chip doesn't support it.*
