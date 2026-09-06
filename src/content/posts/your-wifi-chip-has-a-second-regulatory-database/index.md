---
title: "Your Wi-Fi chip has a second regulatory database, and it wins"
description: "A Raspberry Pi could not see a 5 GHz access point three metres away. iw phy said the channel was enabled. It was telling the truth, and it was completely irrelevant."
date: 2026-09-06
category: tech
tags: ["wifi", "raspberry-pi", "linux", "brcmfmac", "networking"]
draft: true
---

The access point was three metres away, reporting -45 dBm to every
other device in the house. The Pi scanned three times and found
nothing.

`iw phy phy0 info` insisted the channel was enabled. It was telling the
truth. It was also completely irrelevant, because on this radio the
kernel does not do the scanning.

## The false trail

Here is the output that stops most people, taken on this Pi with the
regulatory domain set to `US`:

```
$ iw phy phy0 info | grep -E "57[0-9]{2}|58[0-9]{2}"
  * 5745.0 MHz [149] (20.0 dBm)
  * 5765.0 MHz [153] (20.0 dBm)
  * 5785.0 MHz [157] (20.0 dBm)
  * 5805.0 MHz [161] (20.0 dBm)
  * 5825.0 MHz [165] (20.0 dBm)
```

No `disabled`, no `no IR`, no radar annotation. Channels 149 through
165 — the UNII-3 block — are present and permitted at 20 dBm.

If you run that command, see your channel listed, and conclude the
problem must be at the access point, you have made an entirely
reasonable inference from the wrong source of truth.

## Two tables, and they do not agree

This is the command that reframes the problem:

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

Two blocks. `global` is the kernel's cfg80211 view, built from
`regulatory.db` — the one `apt` updates, the one every tutorial talks
about. `phy#0` is what the **device itself** reports, and it is a
different object entirely.

Look at how different. The kernel's table has sharp band edges, real
per-band power limits, and DFS correctly marked on the ranges that
require it. The device's table has round numbers, a flat 20 dBm
everywhere, no DFS marking at all, and a 2474-2494 MHz entry — that is
channel 14, which is Japan-only and has been for its entire existence.

That is not a `regulatory.db` entry. That is a firmware blob's idea of
the world.

The obvious question, and the one worth sitting with: **why does a
radio have its own opinion about regulation at all?**

## FullMAC: the firmware does the scanning

```
$ ls -l /sys/class/net/wlan0/device/driver
... -> .../bus/sdio/drivers/brcmfmac
```

`brcmfmac` drives Broadcom/Cypress parts, and these are **FullMAC**
devices. The MAC layer — association, and crucially *scanning* — runs on
the chip's own processor, not in the Linux kernel. The host driver
mostly passes requests down and results up.

That single architectural fact is the whole post. On a SoftMAC card, the
kernel builds the scan and the kernel's regulatory view governs it. On a
FullMAC card, you ask the firmware to scan and the firmware decides what
it is willing to look at, using a regulatory table compiled into the
blob.

Here is the blob on this board:

```
brcmfmac: using brcm/brcmfmac43455-sdio
          for chip BCM4345/6
brcmfmac: Firmware: BCM4345/6 wl0:
          Aug 29 2023 01:47:08
          version 7.45.265 (28bca26 CY)
```

Firmware built **29 August 2023**. Its internal country tables are that
old, and `apt upgrade` of `wireless-regdb` does not touch them — those
are two entirely separate update paths, and only one of them is the one
you have been maintaining.

There is a related diagnostic in the same boot, worth noting because it
shows the firmware failing to load one of its own data tables:

```
brcmfmac: brcmf_c_process_txcap_blob:
  no txcap_blob available (err=-2)
```

## What is actually pinned on this box

The Pi is currently running with the regulatory domain forced to `US`,
in two places. In `/boot/firmware/cmdline.txt`:

```
... rootwait cfg80211.ieee80211_regdom=US
```

and in `/etc/modprobe.d/cfg80211.conf`:

```
options cfg80211 ieee80211_regdom=US
```

Live, in the running kernel:

```
$ cat /sys/module/cfg80211/parameters/\
ieee80211_regdom
US
```

With that in place the UNII-3 channels are available and the access
point is visible. The problem is solved on this machine, and has been
for a while.

## The part I have not proved

I want to separate what I have measured from what I believe, because
the gap matters and most write-ups of this problem do not mark it.

**What is measured:** the two tables above disagree. The device's table
is coarse, stale-looking, and clearly not sourced from `regulatory.db`.
The firmware dates from 2023. With the domain pinned to `US`, UNII-3
works.

**What I believe but have not demonstrated:** that setting the domain to
`IN` produces a firmware channel table that omits 149-165, and that this
is why the scans came back empty.

The evidence I have for that is a scan result — zero hits across three
attempts — recorded on this box in July 2026. A scan returning nothing
and a channel table omitting an entry are *different things*, and I have
conflated them before. The experiment that would settle it is specific:
set the domain to `IN`, dump `iw phy phy0 info`, and show 5745-5825
absent *while* the kernel's own `IN` entry in `regulatory.db` contains
5725-5875. Kernel says allowed, radio says no, therefore firmware.

I have not run it. This Pi is in another room and its only uplink is
that Wi-Fi adapter, so the failure mode of getting it wrong is losing
the machine. Doing it properly means arming a scheduled revert *before*
making the change, not after.

The genuinely new result would be dumping the firmware's CLM blob
country table directly and showing which channels `IN` contains. I do
not currently know a method for that on this part, and I could not find
one published.

So: treat the causal story here as the leading hypothesis with strong
circumstantial support, not as a demonstrated fact. The diagnostic
lesson — that `iw reg get` shows you two tables and only one of them is
doing the scanning — stands on its own regardless.

Two more things I have not verified and am therefore not asserting.
Whether newer `firmware-brcm80211` packages ship a different CLM with a
corrected table. And whether the Pi 5's radio is genuinely the same part
as older boards — `dmesg` here says `BCM4345/6` with
`brcmfmac43455-sdio`, which is the Pi 4 / Pi 400 chip, so do not
generalise "the Pi" from this one board without checking your own.

## If you are going to change it

The regulatory situation in India is that the 5725-5875 MHz band is
delicensed for low-power indoor use, and the kernel's own `IN` entry in
`regulatory.db` reflects that — it includes 5725-5875. What appears to
be stale is a vendor blob from 2023, not the law.

I am describing what the regulatory database and the delicensing
notifications say. I am not telling you it is lawful to set a foreign
country code on your hardware, and you should read the primary
notification for your own jurisdiction rather than trusting a blog post
— including this one. I have not read the primary gazette document
myself, which is exactly why I am not going to make a claim about what
your regulator permits.

The mechanical notes, if you proceed:

**Set it in both places.** The kernel command line and
`/etc/modprobe.d/`. One without the other survives some boots and not
others.

**Know what you give up.** Pinning `US` gains you 149-165, and as it
happens 100-144 as well. It costs you 2.4 GHz channels 12 and 13, which
`US` does not permit.

**Arm the revert first.** On a headless, Wi-Fi-only box, schedule the
restore before you apply the change, so a mistake costs you five minutes
rather than a trip with a keyboard.

**Watch out for `raspi-config nonint do_wifi_country`.** It fails
loudly in some situations and succeeds silently in others, which is the
worst combination for something you are using to verify state. Check
`/sys/module/cfg80211/parameters/ieee80211_regdom` afterwards rather
than trusting the tool's exit code.

## The loose thread

I have not been able to explain `country 98` and `country 99`.

Those are not ISO-3166 alpha-2 codes. The `global` block's ranges look
broadly like a US table and the module parameter reads `US`, so
something is mapping oddly somewhere between the parameter, cfg80211 and
the driver's self-report. I do not know what, and I would rather leave
that written down as an open question than invent a tidy explanation for
it.

If you know, I would like to.

---

*Observed on this box 2026-09-02: Raspberry Pi 5, Debian 13,
`brcmfmac43455-sdio`, chip `BCM4345/6`, firmware version 7.45.265
(28bca26 CY) dated 2023-08-29. The regulatory domain is pinned to `US`
here and the UNII-3 channels work. The claim that the firmware's `IN`
table omits channels 149-165 is inferred from a scan result and has not
been demonstrated by a channel-table dump; the experiment that would
demonstrate it is described above and has not been run. 6 GHz is out of
scope — this NIC reports `6GHZ: no`.*
