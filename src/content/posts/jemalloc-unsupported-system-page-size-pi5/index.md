---
title: "<jemalloc>: Unsupported system page size — the Pi 5 bug behind a dozen unrelated tools"
description: "One compile-time constant in a memory allocator takes out Pagefind, Typesense, Immich, Falco and more on a Raspberry Pi 5. The mechanism, the four fixes, and their real costs."
date: 2026-09-03
category: tech
tags: ["raspberry-pi", "jemalloc", "aarch64", "debugging"]
draft: true
---

Your photo library will not start. The error is about a memory allocator
you have never heard of, inside a search engine you did not know you had
installed. Nothing is wrong with either of them.

```
<jemalloc>: Unsupported system page size
memory allocation of 16 bytes failed
```

Two commands tell you whether you are in the right place:

```
$ getconf PAGESIZE
16384
$ uname -r
6.12.75+rpt-rpi-2712
```

If the first prints `16384`, this post is about your machine.

## What is actually happening

jemalloc is a memory allocator. It is compiled with a fixed `LG_PAGE` —
the base-2 log of the page size it expects. At startup it asks the
kernel for the real page size via `sysconf(_SC_PAGESIZE)`. If the answer
is not one it was built for, it aborts immediately rather than allocate
memory it would manage incorrectly.

The Raspberry Pi 5 uses **16 KB pages**. Most jemalloc builds in the
wild assume 4 KB.

That is the entire bug. It is not a Raspberry Pi defect, and it is not a
bug in the application that printed the error. Rust programs that vendor
jemalloc through `tikv-jemallocator` inherit whatever page size the
vendored build was configured with, and most of them never think about
it, because on x86-64 and on almost every ARM server image the answer is
4 KB and always has been.

The kernel suffix above is the second half of the story. Raspberry Pi's
own `config.txt` documentation says it plainly:

> "The Raspberry Pi 5, 500, 500+, and Compute Module 5 firmware defaults
> to loading `kernel_2712.img` because this image contains optimisations
> specific to those models (for example, 16K page-size)."

`-2712` is the BCM2712 kernel and it is the 16 KB one. `-v8` is the
generic 4 KB build. Nothing in my `/boot/firmware/config.txt` selects
either; the firmware default picks the first, which is why this happens
to people who have never edited a boot file in their lives.

## It is not your tool

This is the part nobody has written down in one place. The same eleven
words come out of projects that have nothing to do with each other:

| Project | Issue |
|---|---|
| Pagefind | [#1147 — Raspberry Pi 5 crash in 1.5.2 due to jemalloc / 16KB page size](https://github.com/Pagefind/pagefind/issues/1147) |
| Typesense | [#1351 — Raspberry Pi 5 page size issues (ARM - 16K page size)](https://github.com/typesense/typesense/issues/1351) |
| Quickwit | [#4785 — jemalloc failure on raspberry pi 5](https://github.com/quickwit-oss/quickwit/issues/4785) |
| RethinkDB | [#7156 — Error `<jemalloc>: Unsupported system page size`](https://github.com/rethinkdb/rethinkdb/issues/7156) |
| Falco | [#3476 — [FATAL]: `<jemalloc>: Unsupported system page size`](https://github.com/falcosecurity/falco/issues/3476) |
| EasyTier | [#1990 — jemalloc "Unsupported system page size" on Raspberry Pi 5 since v2.4.0](https://github.com/EasyTier/EasyTier/issues/1990) |
| ripgrep | [#2180 — jemalloc don't works on 16KB page kernel](https://github.com/BurntSushi/ripgrep/issues/2180) |
| Windmill | [#4422 — `<jemalloc>: Unsupported system page size` on ARM64](https://github.com/windmill-labs/windmill/issues/4422) |
| Home Assistant | [#105768 — on raspberry pi 5 with container image 2023.12.2](https://github.com/home-assistant/core/issues/105768) |
| Immich | [#5464 — Pi 5 cannot run Immich because of Typesense error](https://github.com/immich-app/immich/issues/5464) |
| Matter SDK | [#31396 — Raspberry Pi 5 error setting up environment](https://github.com/project-chip/connectedhomeip/issues/31396) |
| Elastic Agent | [Raspberry Pi 5 default page size results in uninstall and integration errors](https://discuss.elastic.co/t/raspberry-pi-5-default-page-size-results-in-uninstall-and-integration-errors-due-to-jemalloc-unsupported-page-size/379781) |

Issue titles and dates as filed; I have not re-checked the current
open/closed state of every one of them, and some may have been fixed
upstream since. Pagefind #1147 was opened 2026-04-24 and was still open
when I checked on 2026-09-02.

Four of those titles are nearly identical. That is people typing the
error into GitHub's search box, finding nothing that explains it, and
opening another duplicate.

The Immich entry is the best illustration of the blast radius. Immich
does not use jemalloc. Immich uses Typesense. Typesense uses jemalloc.
The user sees a photo app fail to start.

It is also not a Raspberry Pi problem specifically — a
[Manjaro ARM thread](https://forum.manjaro.org/t/problem-of-jemalloc-system-page-size/175855)
has the same error. Any aarch64 distro shipping a 16 KB-page kernel
lands in the same hole, which includes some Apple Silicon and Ampere
images.

## The build flag, not the hardware

Here is the thing that took me longest to believe, checked on this box
on 2026-09-03.

There is a ripgrep on this Pi — the static `linux-arm64` binary that
ships inside the VS Code server. It is a jemalloc build; the abort path
is right there in the binary:

```
$ strings .../ripgrep-universal/bin/linux-arm64/rg \
    | grep -i "unsupported system page size"
<jemalloc>: Unsupported system page size
```

And it runs:

```
$ .../bin/linux-arm64/rg --version
ripgrep 15.0.0
```

Exit code 0, on the same CPU, the same kernel, the same 16 KB pages that
kill Pagefind. Same allocator, same error string compiled in, no abort.

So "jemalloc does not work on 16 KB pages" is false as stated. jemalloc
built for a larger page size copes with smaller ones at runtime; jemalloc
built assuming 4 KB does not cope with anything bigger. Every entry in
that table is a *packaging* decision, not a hardware limit. Which is
also why a fix can land upstream without anyone touching your Pi.

(I want to correct something I assumed before I ran that: I had listed
Claude Code's bundled ripgrep as a casualty. There is no such binary on
this machine, and the ripgrep that is here works fine. It was a guess and
it was wrong.)

**Checking your own binary** takes one command:

```
$ strings /path/to/binary | grep -c "Unsupported system page size"
```

A non-zero count means jemalloc is in there. It does *not* mean the tool
is broken — as above. Run it and find out.

## Four ways out, and what each one costs

**1. Pin an older version.** Cheapest when it exists. Pagefind #1147
reports 1.5.0 working and 1.5.2 crashing, so the regression landed around
1.5.1. **I have now tested that on this box, and the issue is exactly
right:**

```
$ npx -y pagefind@1.4.0 --version
pagefind 1.4.0

$ npx -y pagefind@1.5.0 --version
pagefind 1.5.0

$ npx -y pagefind@1.5.2 --version
<jemalloc>: Unsupported system page size
<jemalloc>: Unsupported system page size
memory allocation of 16 bytes failed
```

And 1.5.0 does not merely start — it indexes:

```
$ npx -y pagefind@1.5.0 --site dist \
    --output-path /tmp/pf-test
[Building search indexes]
  Indexed 1 language
  Indexed 1 page
  Indexed 88 words
Finished in 0.445 seconds
```

So on this hardware Pagefind has a working, pinnable release, and the
crash is a regression rather than a permanent incompatibility. It is
also the option nobody in the other issue threads has, because it is
specific to one project's history.

**2. Boot the 4 KB kernel.** Both kernels are already on your Pi. No
download:

```
$ ls -la /boot/firmware/*.img
-rwxr-xr-x 1 root root 9698043 Apr 19 10:57 /boot/firmware/kernel_2712.img
-rwxr-xr-x 1 root root 9695883 Apr 19 10:57 /boot/firmware/kernel8.img

$ ls -1 /lib/modules/
6.12.47+rpt-rpi-2712
6.12.47+rpt-rpi-v8
6.12.75+rpt-rpi-2712
6.12.75+rpt-rpi-v8
```

The line, in `/boot/firmware/config.txt`, then a reboot:

```
kernel=kernel8.img
```

Two details most write-ups get wrong. The value is a *filename on the
boot partition* — `kernel=rpi-v8` is not valid syntax. And `rpi-v8` is
the Debian package flavour, which is what `uname -r` will read
afterwards; it is not what goes after `kernel=`. Make sure the line is
not inside a `[cm4]`-style conditional block that excludes your board.

The cost is the part the forum answers skip: this is a **global** change.
Every process on the box gets 4 KB pages, to satisfy one dependency. The
16 KB default exists because it is better on this hardware — Raspberry Pi
calls it an optimisation, though they publish no number I can quote — and
you are trading it away.

**3. Rebuild the tool without jemalloc, or with a bigger `LG_PAGE`.**
Correct, permanent, and the real upstream fix. Also the most expensive:
you now maintain a build. I am not publishing a recipe I have not run.

**4. Replace the tool.** Sometimes the dependency is not worth the
argument.

## What I picked

Option 4. Pagefind was going to be the search layer for this blog; it
died three seconds into the build, and reproduced standalone with
`npx pagefind --site dist`, so it was the binary and not an Astro
integration problem.

This Pi is in another room, its only uplink is `wlan0`, and it runs nine
other services. A reboot into a different memory model, on a box I cannot
reach the HDMI port of, to satisfy the search box on a blog with two
posts on it, is not a trade I was going to make. I swapped in MiniSearch
instead — that is [its own post](/blog/).

If the tool that broke for you is the point of the machine, weigh it the
other way. Option 2 is one line and a reboot, and it works.

**An honest postscript.** When I made that call I had not run option 1.
I have now, and `pagefind@1.5.0` works here — so the choice I actually
faced was not "Pagefind or nothing", it was "pin a release that upstream
has moved past, or switch". I still think switching was right, because a
pin is a debt with no repayment date: the version that works is the
version before the fix I am waiting for. But the post would be dishonest
if it let you believe the tool was unusable on this board. It is not.
It is unusable *at current*.

---

*Verified on this box 2026-09-02, 2026-09-03 and 2026-09-06: Raspberry
Pi 5, `6.12.75+rpt-rpi-2712`, `getconf PAGESIZE` = 16384. The Pagefind
version matrix above was run 2026-09-06. Issue links are as filed; check
their current state before relying on them.*
