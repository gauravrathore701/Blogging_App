---
title: "Self-hosting when the hardware got expensive"
description: "The 16 GB Pi 5 went from $120 to $305 in twenty months, so obviously you should rent a server instead. Small problem: rent went up too, for exactly the same reason."
date: 2026-09-06
category: tech
tags: ["self-hosting", "raspberry-pi", "cost", "hardware", "hetzner"]
draft: false
---

The 16 GB Raspberry Pi 5 launched at $120 in January 2025. It now costs
$305.

It didn't happen all at once. It went up in steps, the way a boiling
frog gets warm, except the frog is your wallet:

```
Jan 2025   $120   launch
Dec 2025   $145
Feb 2026   $205
Apr 2026   $305
```

That's two and a half times the launch price, up 154%, for a board
that hasn't gained a single new feature in the meantime.

To their credit, Raspberry Pi didn't hide behind "market conditions" or
"supply chain headwinds". They named the culprit. From the April
announcement: *"a seven-fold increase over the last year in the price
of the LPDDR4 DRAM"*.

Seven-fold. Memory chips had a better year than most investment
portfolios.

The internet's conclusion writes itself: the cheap home server is dead,
go rent a VPS like a normal person.

I'd like to check that before I agree with it, because I don't think
the people saying it have looked at the other half of the receipt.

## Plot twist: rent went up too

Hetzner raised prices on its Arm servers, effective **15 June 2026**:

```
CAX21   EUR  7.99  ->  10.49   (+31%)
CAX31   EUR 15.99  ->  20.99   (+31%)
```

OVH's VPS-1 reportedly went up around 55% in the same window. (That one
comes from a secondary source. I haven't confirmed it on OVH's own
site.)

Same year, same DRAM shortage, same direction. It turns out a VPS is
mostly memory with a monthly invoice stapled to it. When memory gets
seven times more expensive, the company renting it to you notices. Then
you notice.

Most of the "just rent it" takes I've read this year make the same quiet
mistake. They compare **this year's** hardware price against **last
year's** rent. Of course renting wins that fight. It's boxing a ghost.

Renting didn't win. Everything just got worse at the same time, which is
less satisfying but more accurate. The question is still open, and
that's already more than most write-ups will admit.

## What's actually running on this thing

You can't argue about whether a server is worth it without saying what
it does all day, so here's mine. A Raspberry Pi 5 with 16 GB, Debian 13,
kernel `6.12.75+rpt-rpi-2712`, four cores topping out at 2.4 GHz. About
twenty services I set up by hand, all behind one Cloudflare tunnel, with
zero ports open to the internet.

Here's how much memory each one actually holds. I measured it on
2026-09-05 by adding up the resident memory of every process in each
service's cgroup:

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

Plus MongoDB 8 in Docker at 228 MiB, listening only on localhost, holding
a 457 MB dataset. Its WiredTiger cache is deliberately capped at 0.5 GB
so it doesn't get ideas.

`*` That 433 MiB includes the CLI session that was *taking these
measurements*, which is a bit like weighing yourself while holding the
scale. It's a busy research session, not the bot sitting idle, and I
didn't measure the idle case separately. Don't read it as steady state.

The spread is the fun part. The two Rust services do their jobs in 6 and
8 MiB. The two Java services need 679 and 320. That's roughly a
hundredfold difference, on the same board, for jobs of broadly similar
importance, and the only thing explaining it is the language runtime.
Rust packed a carry-on. Java brought the wardrobe.

## The number this whole post hangs on

```
$ free -h
        total   used   free   available
Mem:     15Gi  2.5Gi  8.3Gi       13Gi
Swap:   2.0Gi     0B  2.0Gi
```

2.5 GiB used, out of about 16. 13 GiB available. Swap is set up and has
never been touched.

The load average is 0.12 across four cores, so the machine is about 97%
idle. It's sitting at 53.8 °C, and `vcgencmd get_throttled` reports
`0x0`, meaning no throttling whatsoever. It isn't working hard. It's
barely working.

I re-ran `free -h` on 2026-09-06 after a reboot, in case the first one
was a fluke. Same story: 2.3 GiB used, 13 GiB available.

So here's the uncomfortable bit, and it's about my own purchase rather
than Raspberry Pi's pricing: **the expensive part of this board is
exactly the part I don't use.** An 8 GB Pi 5 would run everything above
with room to spare. The extra memory I paid for is doing an excellent
job of being available. World-class availability. Never once busy.

If you're pricing a home server now that RAM is the expensive part, the
first question isn't "which board?" It's "how much memory will my stuff
actually use?" I did answer that question. I just answered it after
paying.

## What it costs to run

**Power.** The Pi 5 can report the current and voltage on each of its
internal power rails. I took ten readings, two seconds apart, multiplied
current by voltage on every rail and added them up, with the box idling
as described above:

```
2.231 2.254 2.260 2.445 2.469
2.508 2.707 2.259 2.185 2.205  W
```

Average **2.35 W**, range 2.19-2.71 W. The hungriest rail is `VDD_CORE`,
at about 1.04 W.

Before anyone screenshots that number, here are four things it is *not*:

- **Not wall power.** It's measured after the power supply, so the
  supply's own losses aren't in it. The Pi 5 can't report its input
  power, and **I haven't put a plug meter on this machine.**
- **Not the hard drive.** The USB ports are fed before those rails, so
  the spinning drive plugged into it isn't counted.
- **Not 27 W.** That's printed on the power supply. It's what the supply
  *can* deliver, not what the Pi draws.
- **Not the monitor.** The screen on my desk isn't a server cost, so it
  doesn't appear anywhere.

My working estimate is **about 5 W at the wall**: roughly 2.8 W once you
add power-supply losses, plus about 2 W for the drive. I'll run the
maths from 3 W to 7 W, because the conclusion doesn't change anywhere in
that range.

**Electricity, at a real tariff.** MSEDCL is the electricity distributor
here. According to the MERC multi-year tariff order dated 28 March 2025,
for LT Residential in FY 2026-27, the 101-300 unit slab is ₹9.40 energy
plus ₹1.20 wheeling = **₹10.60/kWh**, before a 16% residential
electricity duty.

```
5 W x 8,766 h / 1000 = 43.8 kWh/year
43.8 x ₹12.30 (incl. duty) = ₹539/yr
```

At either end of the range: 3 W is ₹323 a year, 7 W is ₹755.

That same order also publishes tariffs all the way out to FY 2029-30,
which is very considerate of it if you happen to want a five-year total.
So:

**Five years of electricity for this entire box comes to about ₹2,723,
or roughly $29.** That's under a tenth of what the board itself costs
today.

The classic "but what about the electricity?" objection is, at this
wattage and this tariff, dead on arrival. Better still, that same order
headlines an overall *reduction* in residential tariffs of 10-12%.
Electricity got cheaper while the board got 154% more expensive. The one
bill that was supposed to be scary is the one that behaved.

**Bandwidth.** About 10.4 GiB a month going out.

## Why I'm not handing you a verdict

This is the part where posts like this unveil a table with the winner in
bold. I'm not going to, and it's not because I'm being mysterious.

A fair build-versus-rent answer needs three numbers I haven't measured:

1. **Real power at the wall**, not rail power. Everything built on that
   5 W estimate inherits its error.
2. **A real price for the alternative.** The usual alternative is an
   Intel N100 mini PC, and I haven't priced one from an actual shop
   listing I'd stand behind.
3. **How much that mini PC draws at idle**, which is the entire basis of
   any "efficiency" argument.

If I made those up, you'd get a very confident-looking table that's
really just my gut feeling wearing decimal points. So here's the method
instead, plus my numbers where I have them.

**Do the sum yourself:**

- **Your hardware price**, delivered, in your currency. Mine is $305 list
  today. The one I actually own was bought earlier and cost less.
- **Your marginal electricity rate**, including duty. That's the slab
  you're actually *in*, not the average.
- **The idle power gap** between the two machines you're comparing.
- **The rent for the equivalent VPS as of this month**, plus the extras
  that make a €10.49 VPS not cost €10.49: egress overage, block storage,
  an IPv4 address, backups.

Then ask one question: how many years of power savings does it take to
pay back the price difference?

For a Pi against a typical x86 mini PC, at the power gaps people usually
quote and the tariff above, the payback comes out in **decades**. That's
longer than either machine will realistically live. Even a generous 15 W
gap, against a price gap of about $155, only gets it down to around nine
years. Treat those as the shape of the answer, not a figure: the $155
rests on a price range I haven't checked, and inputs 2 and 3 are
unmeasured.

The shape holds even if the exact number doesn't. At single-digit watts
and ₹12/kWh, electricity simply isn't the thing that decides this.
Anyone telling you a home server is cheap *because it sips power* has
the right answer for the wrong reason. The electricity was never the
expensive part. The board is.

## Where renting just wins

I'd rather point these out myself than pretend this box is perfect.

**This blog.** A static blog could live on any free static host, and
those free tiers are genuinely generous. It lives here because I wanted
the whole pipeline on hardware I control. That's a preference, not an
economic argument, and I've made my peace with it.

**Tiny hobby sites.** Four of the static apps in that table use 19-70 MiB
each and get basically no visitors. They're on the Pi because the Pi was
already there. Squatters' rights.

**CI.** The Java CI server uses 679 MiB, more than anything else on the
machine, to run three jobs. Three. That's the clearest loss on this box
by a mile, and it deserves its own post rather than a paragraph here.

## What this doesn't settle

Mostly, uptime. I can't give you an availability figure, because when I
measured, the system journal only went back to 30 August 2026. Anyone
quoting you "five nines" for a Pi in a spare room, with no UPS, on home
broadband, is quoting you a vibe.

Then there's the honest, non-financial part. A home server is a hobby
with a cost basis. I don't run one because a spreadsheet told me to. I
run it because I like knowing where my stuff lives and being able to
read the logs. Conveniently, that reason survives a price rise. Which is
lucky, because there's been a big one.

So here's the one thing I'll say with confidence: **"the Pi got
expensive, so rent instead" doesn't follow.** Rent got more expensive
too, from the same DRAM crunch, in the same year, by about a third.
Whatever you pick, compare it against *this month's* prices on both
sides, not last year's.

---

*Measured on this box 2026-09-05, re-checked 2026-09-06: Raspberry Pi 5
Model B Rev 1.1, Debian 13 (trixie), kernel `6.12.75+rpt-rpi-2712`,
16 GB. Hardware prices from raspberrypi.com and Hetzner's own price
adjustment notice, fetched 2026-09-05. Re-check both before relying on
them; one of them has gone up three times since launch. OVH's increase
is from a secondary source. Tariffs from the MERC MYT order dated 28
March 2025. The 16% electricity duty is from secondary sources and has
not been checked against a statute or a bill. Wall power, the N100
comparison figures and this box's annual availability are not measured,
and nothing here asserts them.*
