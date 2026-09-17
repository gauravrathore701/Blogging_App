---
title: "Pagefind died on my Raspberry Pi 5 with \"Unsupported system page size\" — and it's not the only one"
description: "On a Raspberry Pi 5, Pagefind and a dozen unrelated tools abort with '<jemalloc>: Unsupported system page size'. Why 16 KB pages cause it, and four ways out with their real costs."
date: 2026-09-03
category: tech
tags: ["raspberry-pi", "jemalloc", "aarch64", "debugging"]
draft: true
---

I wanted a search box on this blog, which runs on a Raspberry Pi 5. So I added Pagefind, a static search indexer, and ran the build. Pagefind didn't index anything. It didn't even get going. It died on the spot with two lines that had nothing to do with search:

```
<jemalloc>: Unsupported system page size
memory allocation of 16 bytes failed
```

Running it on its own with `npx pagefind --site dist` did exactly the same thing, so it wasn't Astro or my config. It was the Pagefind binary against this Pi. And the error wasn't really about Pagefind either — it's about a memory allocator called jemalloc, and it turns out a *lot* of unrelated software trips over the same line on a Pi 5.

Two commands tell you whether you're in the same boat:

```
$ getconf PAGESIZE
16384
$ uname -r
6.12.75+rpt-rpi-2712
```

If the first one prints `16384`, this post is about your machine.

## One number the allocator didn't expect

jemalloc is a memory allocator — the bit of a program that hands out and tidies up memory. When it's built, it gets a fixed setting called `LG_PAGE`: the page size it expects, stored as a power of two. At startup it asks the kernel for the real page size. If the answer isn't one it can handle, it gives up immediately rather than manage memory wrongly.

The Raspberry Pi 5 uses **16 KB memory pages**. Most jemalloc builds out there assume 4 KB.

That's the entire bug. It isn't a Raspberry Pi defect, and it isn't really a bug in whichever app printed the error. Rust programs that pull jemalloc in through `tikv-jemallocator` inherit whatever page size that bundled copy was built for, and most never think about it, because on x86-64 and most ARM server images the answer has been 4 KB forever.

The `-2712` on the end of that kernel version is the other half of the story. Raspberry Pi's own `config.txt` documentation spells it out:

> The Raspberry Pi 5, 500, 500+, and Compute Module 5 firmware defaults
> to loading `kernel_2712.img` because this image contains optimisations
> specific to those models (for example, 16K page-size).

So `-2712` is the Pi 5 kernel with 16 KB pages, and `-v8` is the generic 4 KB build. Nothing in my `/boot/firmware/config.txt` picks either one — the firmware default picks the 16 KB kernel. That's why this happens to people who have never touched a boot file in their lives.

## It's not your tool. It's everyone's tool.

The exact same error comes out of projects that have nothing to do with each other. Here's what I found, with each issue's state as of 2026-09-17:

| Project | Issue | State |
|---|---|---|
| Pagefind | [#1147 — Raspberry Pi 5 crash in 1.5.2 due to jemalloc / 16KB page size](https://github.com/Pagefind/pagefind/issues/1147) | open |
| Typesense | [#1351 — Raspberry Pi 5 page size issues (ARM - 16K page size)](https://github.com/typesense/typesense/issues/1351) | closed |
| Quickwit | [#4785 — jemalloc failure on raspberry pi 5](https://github.com/quickwit-oss/quickwit/issues/4785) | open |
| RethinkDB | [#7156 — Error `<jemalloc>: Unsupported system page size`](https://github.com/rethinkdb/rethinkdb/issues/7156) | open |
| Falco | [#3476 — [FATAL]: `<jemalloc>: Unsupported system page size`](https://github.com/falcosecurity/falco/issues/3476) | closed |
| EasyTier | [#1990 — jemalloc "Unsupported system page size" on Raspberry Pi 5](https://github.com/EasyTier/EasyTier/issues/1990) | closed |
| ripgrep | [#2180 — jemalloc don't works on 16KB page kernel](https://github.com/BurntSushi/ripgrep/issues/2180) | closed |
| Windmill | [#4422 — `<jemalloc>: Unsupported system page size` on ARM64](https://github.com/windmill-labs/windmill/issues/4422) | open |
| Home Assistant | [#105768 — on raspberry pi 5 with container image 2023.12.2](https://github.com/home-assistant/core/issues/105768) | closed |
| Immich | [#5464 — Pi 5 cannot run Immich because of Typesense error](https://github.com/immich-app/immich/issues/5464) | closed |
| Matter SDK | [#31396 — Raspberry Pi 5 error setting up environment](https://github.com/project-chip/connectedhomeip/issues/31396) | open |
| Elastic Agent | [Raspberry Pi 5 default page size results in uninstall and integration errors](https://discuss.elastic.co/t/raspberry-pi-5-default-page-size-results-in-uninstall-and-integration-errors-due-to-jemalloc-unsupported-page-size/379781) | forum thread |

"Closed" means the issue tracker marked it done. I haven't tested each project's fix myself.

The Immich one shows how far this reaches. Immich doesn't use jemalloc. Back when that issue was filed, Immich used Typesense for search, and Typesense used jemalloc. So what the user saw was a *photo app* refusing to start because of a memory allocator three layers down.

It isn't purely a Raspberry Pi thing either — a [Manjaro ARM forum thread](https://forum.manjaro.org/t/problem-of-jemalloc-system-page-size/175855) hits the same error. Any 64-bit ARM system running a 16 KB-page kernel can land in the same hole.

## Same chip, same kernel, same jemalloc — and it works

This is the part that took me longest to believe.

There's a ripgrep on this Pi: the ARM64 binary that ships inside the VS Code server. It contains jemalloc — the error message is sitting right there inside the binary:

```
$ strings .../linux-arm64/rg \
    | grep -c "Unsupported system page size"
1
```

And it runs perfectly happily:

```
$ .../linux-arm64/rg --version
ripgrep 15.0.0
```

Exit code 0. Same CPU, same kernel, same 16 KB pages that kill Pagefind. Same allocator, same error message compiled in, and no crash. (Checked on 2026-09-03 and again on 2026-09-17.)

So "jemalloc doesn't work on 16 KB pages" isn't true as stated. My understanding is that jemalloc built for a larger page size copes with smaller real pages, while jemalloc built for 4 KB can't cope with anything bigger — and this ripgrep is consistent with that. Either way, every entry in that table is a *build* choice, not a hardware limit. Which is good news: it can be fixed upstream without anyone touching your Pi.

One correction to my own early notes: I'd assumed Claude Code's bundled ripgrep was another casualty. There's no such binary on this machine, and the ripgrep that is here works fine. It was a guess, and it was wrong.

**Want to check a binary of your own?** One command:

```
$ strings /path/to/binary \
    | grep -c "Unsupported system page size"
```

A number above zero means jemalloc is inside. It does *not* mean the tool is broken — see ripgrep above. The only real test is running it.

## Four ways out, and what each one costs

**1. Pin an older version.** Cheapest, when there is one. Pagefind #1147 reports 1.5.0 working and 1.5.2 crashing. There's no 1.5.1 on npm, so the breakage arrived somewhere between those two releases. I tested it on this Pi on 2026-09-06, and the issue is exactly right:

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

And 1.5.0 doesn't just start — it actually indexes:

```
$ npx -y pagefind@1.5.0 --site dist \
    --output-path /tmp/pf-test
[Building search indexes]
  Indexed 1 language
  Indexed 1 page
  Indexed 88 words
Finished in 0.445 seconds
```

I re-ran the version checks on 2026-09-17: 1.5.0 still starts, 1.5.2 still crashes, and 1.5.2 is still the newest release on npm.

**2. Boot the 4 KB kernel.** Both kernels are already on your Pi. No download needed:

```
$ ls -la /boot/firmware/*.img
... 9698043 Apr 19 10:57 kernel_2712.img
... 9695883 Apr 19 10:57 kernel8.img

$ ls -1 /lib/modules/
6.12.47+rpt-rpi-2712
6.12.47+rpt-rpi-v8
6.12.75+rpt-rpi-2712
6.12.75+rpt-rpi-v8
```

Add this line to `/boot/firmware/config.txt`, then reboot:

```
kernel=kernel8.img
```

Two details most write-ups get wrong. The value is a *file name on the boot partition* — `kernel=rpi-v8` isn't valid. And `rpi-v8` is the Debian package flavour, which is what `uname -r` will show afterwards; it's not what goes after `kernel=`. Also make sure the line isn't sitting inside a board-specific section like `[cm4]` that doesn't apply to your Pi.

The catch the forum answers skip: this is a **global** change. Every process on the machine gets 4 KB pages, just to keep one program happy. The 16 KB default exists because Raspberry Pi considers it an optimisation for this hardware (they don't publish a number I can quote), and you're giving that up.

**3. Rebuild the tool without jemalloc, or for a bigger page size.** The correct, permanent fix, and the real upstream one. Also the most expensive: now you maintain a build. I haven't done it, so I'm not publishing a recipe.

**4. Replace the tool.** Sometimes a dependency just isn't worth the fight.

## What I actually did (and what I missed)

I picked option 4.

This Pi is headless, I manage it over SSH, and its only network connection is Wi-Fi. Rebooting it into a different memory model — with no screen or keyboard attached if it didn't come back — just so a small blog could have a search box, wasn't a trade I was willing to make. Everything else running on the box would have paid for it too. So I swapped Pagefind for MiniSearch instead; that's a separate post.

If the tool that broke for you is the whole point of your Pi, weigh it the other way. Option 2 is one line and a reboot, and it works.

**An honest postscript.** When I made that call, I hadn't tried option 1. I have now, and `pagefind@1.5.0` works here. So the real choice wasn't "Pagefind or nothing" — it was "pin an old release, or switch". I still think switching was right, because a pin is a debt with no due date: the version that works is the one *before* the fix I'd be waiting for. But it would be dishonest to let you think Pagefind can't run on a Pi 5. It can. It just can't run the latest release — yet.

---

*Checked on this Pi: Raspberry Pi 5, kernel `6.12.75+rpt-rpi-2712`, `getconf PAGESIZE` = 16384, on 2026-09-02, 2026-09-03, 2026-09-06 and 2026-09-17. The full Pagefind version test and the 1.5.0 indexing run are from 2026-09-06; the version checks were repeated on 2026-09-17. Issue states were checked on 2026-09-17 and may have changed since.*
