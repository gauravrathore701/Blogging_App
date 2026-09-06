---
title: "Self-hosting when the hardware got expensive"
description: "The 16 GB Pi 5 went from $120 to $305 in twenty months. The obvious response is to rent instead — except rent went up 31% the same year, from the same cause. Both columns inflated."
date: 2026-09-06
category: tech
tags: ["self-hosting", "raspberry-pi", "cost", "hardware", "hetzner"]
draft: true
---

The 16 GB Raspberry Pi 5 launched at $120 in January 2025. Today it is
$305.

That is four price rises in twenty months — $120, then $145 in December
2025, then $205 in February 2026, then $305 in April — and Raspberry Pi
has been unusually direct about why. Their own wording, from the April
announcement, is *"a seven-fold increase over the last year in the
price of the LPDDR4 DRAM"*.

Two and a half times the launch price. Up 154%.

So the obvious conclusion is that the cheap-home-server era is over and
you should rent a VPS instead.

I want to check that conclusion, because I do not think the people
reaching it have priced the other side.

## Rent went up too, from exactly the same cause

Hetzner raised prices on its Arm line effective **15 June 2026**:

```
CAX21   EUR  7.99  ->  10.49   (+31%)
CAX31   EUR 15.99  ->  20.99   (+31%)
```

OVH's VPS-1 went up around 55% in the same window.

Same year, same DRAM shortage, same direction. A VPS is mostly memory
you are renting; when memory gets seven times more expensive, the
people renting it to you notice.

This is the part that seems to be missing from every version of this
comparison I have read in 2026: people are comparing **today's**
hardware price against **last year's** rent price, and concluding that
renting won. It did not win. Everything got worse together.

That does not settle the question. It just means the question is still
open, which is more than most write-ups will tell you.

## What is actually on the box

Any honest version of this has to start with the workload, so here is
mine. A Raspberry Pi 5, 16 GB, Debian 13, kernel `6.12.75+rpt-rpi-2712`,
four cores at 1.8 GHz. Twenty or so hand-written application units,
behind one Cloudflare tunnel, with no inbound ports open.

Measured resident memory per unit, summed over each unit's
`cgroup.procs` on 2026-09-05:

```
CI server (Java)            679 MiB
chat->agent bridge*         433 MiB
API connector (Spring)      320 MiB
voice assistant (STT+TTS)   208 MiB
media front end (Next)      129 MiB
personal site (Next)        112 MiB
docker daemon               101 MiB
tailscaled                   93 MiB
containerd                   72 MiB
video server                 69 MiB
routing proxy                68 MiB
cloudflared                  42 MiB
caddy                        41 MiB
static apps (x4)          19-70 MiB
auth API (Rust)               8 MiB
mail service (Rust)           6 MiB
```

Plus MongoDB 8 in Docker at 228 MiB, bound to loopback, holding a
457 MB dataset with a deliberately capped 0.5 GB WiredTiger cache.

`*` That 433 MiB includes the CLI session that was *taking these
measurements*. It is a research session, not an idle footprint, and I
did not separately measure the bot at rest. Do not read it as steady
state.

The spread is the interesting part. The two Rust services do their jobs
in 6 and 8 MiB. The two JVMs need 679 and 320. That is a hundredfold
difference on the same board, for work of broadly comparable
importance, and it is entirely a language-runtime choice.

## The number this whole post turns on

```
$ free -h
        total   used   free   available
Mem:     15Gi  2.5Gi  8.3Gi       13Gi
Swap:   2.0Gi     0B  2.0Gi
```

Two and a half gigabytes used, of about sixteen. Thirteen available.
Swap configured and completely untouched. Load average 0.12 across four
cores — the box is roughly 97% idle, at full clock, 53.8 °C, with
`vcgencmd get_throttled` reporting `0x0`.

I re-checked `free -h` on 2026-09-06 after a reboot and it says
substantially the same thing: 2.3 GiB used, 13 GiB available.

So here is the uncomfortable finding, and it is about my own purchase
rather than about Raspberry Pi's pricing: **the expensive thing about
this board is the thing my workload does not use.** An 8 GB Pi 5 would
run all of this with room to spare. The extra memory I paid for is
sitting there being available.

If you are pricing a home server right now on the basis that RAM has
become the expensive component, the first question is not "which board"
but "how much of it will actually be resident". Mine answered that
question after the money was spent.

## What it costs to run

**Power.** The Pi 5 exposes per-rail current and voltage through its
PMIC. Ten samples, two seconds apart, summing current x volts across
all rails, at the idle load described above:

```
2.231 2.254 2.260 2.445 2.469
2.508 2.707 2.259 2.185 2.205  W
```

Mean **2.35 W**, range 2.19-2.71 W. The largest single rail is
`VDD_CORE` at about 1.04 W.

Four things that measurement is not. It is rail power downstream of the
PMIC, so it excludes power-supply conversion loss — the Pi 5 does not
expose input current, and **I have not put a plug meter on this
machine**. The USB ports are fed ahead of these rails, so the attached
spinning drive is not in that figure. The 27 W supply fitted is a
rating, not a draw. And the monitor on the desk is not a server cost
and appears nowhere.

Working estimate: **about 5 W at the wall** — roughly 2.8 W after PSU
losses plus about 2 W for the drive. I will show the answer across
3-7 W, because the conclusion does not change anywhere in that range.

**Electricity, at a real tariff.** MSEDCL is the distribution licensee
here. From the MERC multi-year tariff order dated 28 March 2025, LT
Residential, FY 2026-27, the 101-300 unit slab is ₹9.40 energy plus
₹1.20 wheeling = **₹10.60/kWh**, before a residential electricity duty
of 16%.

```
5 W x 8,766 h / 1000 = 43.8 kWh/year
43.8 x ₹12.30 (incl. duty) = ₹539/yr
```

At the ends of the range: 3 W is ₹323/year, 7 W is ₹755/year.

The same order publishes the tariff trajectory to FY2029-30, which is
unusually convenient for a five-year total. Running it out:

**Five years of electricity for this entire box is about ₹2,723 — call
it $29.** Less than the active cooler cost.

So the "but think of the electricity" objection to self-hosting is, at
this power level and this tariff, arithmetically dead. Note also the
direction of travel: that same order headlines an overall *reduction*
in residential tariffs of 10-12%. Electricity here got cheaper while
the board got 154% more expensive.

**Storage wear.** About 7.2 GiB/day written to the microSD card. I
cannot give you a remaining-life figure: this card exposes `name`,
`manfid`, `oemid`, `serial`, `date`, `fwrev` and `hwrev`, and does not
expose `life_time` or `pre_eol_info`, so the health registers are
simply unavailable. Take the write rate and compute against whatever
endurance rating your own card claims.

**Egress.** About 10.4 GiB/month.

## The comparison, and why I am not going to hand you a verdict

This is where most posts of this type produce a number and a winner. I
am not going to, and the reason is specific rather than coy.

An honest build-versus-rent answer needs three inputs I do not have
measured:

1. **Wall power, not rail power.** Everything downstream of the 5 W
   estimate inherits its error.
2. **A real price for the thing you would buy instead.** An N100 mini
   PC is the usual alternative and I have not priced one from a named
   retail listing I can stand behind.
3. **That machine's actual idle draw**, which is the entire basis of
   any efficiency argument.

Inventing any of those three would produce a confident-looking table
that is really just my prior with decimal places on it. So instead,
here is the method, and my inputs where I have them.

**Run it yourself:**

- Your hardware price, delivered, in your currency. Mine is $305 list
  today; the box I actually own was bought earlier and cost less.
- Your marginal electricity rate, including duty — the slab you are
  *in*, not the average.
- The idle wattage gap between the two machines you are comparing.
- The rent price of the equivalent VPS **as of this month**, plus the
  line items that make a €10.49 VPS not cost €10.49: egress overage,
  block storage, an IPv4 address, backups.

Then the only question that matters: how many years of the power
difference does it take to pay back the price difference?

For the Pi against a typical x86 mini PC, at a wattage gap in the range
people usually quote and at the tariff above, that payback runs to
**decades** — longer than either machine will plausibly live. Even a
generous 15 W gap lands somewhere around nine years. I am stating that
as the shape of the result rather than a figure, precisely because
inputs 2 and 3 are unmeasured.

The shape is robust even though the number is not. At single-digit
watts and ₹12/kWh, power is simply not the deciding variable. Anyone
telling you a home server is cheap *because it sips electricity* has
the right conclusion for the wrong reason — the electricity was never
the expensive part. The board is.

## Where renting simply wins

I would rather name these than pretend the box is optimal.

**A static blog.** This one could live on any free static host, and the
free tiers are genuinely generous. It lives here because I wanted the
whole pipeline on hardware I control, which is a preference, not an
economic argument.

**Small hobby sites.** Four of the static apps in that table cost
19-70 MiB each and get essentially no traffic. They are on a Pi because
the Pi already exists.

**CI.** The Java CI server is 679 MiB — the single largest consumer on
the machine — for three jobs. That is the clearest loss on this box by
a distance, and it deserves its own post rather than a paragraph here.

## What this does not settle

Availability, mostly. I cannot give you an uptime figure: journal
retention on this box only reaches back to 30 August 2026, and there
were at least two multi-hour outages in the last month. Anyone quoting
you nines for a Pi in a spare room, without a UPS and on domestic
broadband, is quoting you a vibe.

And there is the honest non-financial part. A home server is a hobby
with a cost basis. The reason I run one is not that the spreadsheet
says to; it is that I like knowing where my things are and being able
to read the logs. That reason survives a price rise, which is
convenient, because there has been a large one.

The useful finding here is narrower and I will restate it plainly:
**"the Pi got expensive, so rent instead" is a non-sequitur.** Rent got
expensive too, from the same DRAM crunch, in the same year, by about a
third. Whatever you decide, decide it against this month's prices on
both sides.

---

*Measured on this box 2026-09-05, re-checked 2026-09-06: Raspberry Pi 5
Model B Rev 1.1, Debian 13 (trixie), kernel `6.12.75+rpt-rpi-2712`,
16 GB. Hardware prices from raspberrypi.com and Hetzner's own price
adjustment notice, fetched 2026-09-05 — re-check both before relying on
them, since one of them moved four times while I was writing this.
Tariffs from the MERC MYT order dated 28 March 2025. Electricity duty
of 16% is from secondary sources and has not been checked against a
statute or a bill. Wall power, the N100 comparison figures and this
box's annual availability are not measured, and nothing here asserts
them.*
