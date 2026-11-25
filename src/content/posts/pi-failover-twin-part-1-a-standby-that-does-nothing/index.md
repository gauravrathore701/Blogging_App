---
title: "Building a failover twin for my Raspberry Pi, part 1: a standby that does nothing"
description: "My Pi fell off WiFi and took my bot and daily jobs with it. Part 1 of building a free Oracle VM twin: complete copies of everything, and nothing allowed to run."
date: 2026-11-24
category: tech
tags: ["self-hosting", "raspberry-pi", "oracle-cloud", "syncthing", "failover"]
draft: false
---

On 2 November my Raspberry Pi dropped off WiFi. With it went everything that lives on it: the Discord bot I talk to all day, my reminders, the morning reports. None of it came back until I was physically home to fix it, so I'm building it a twin.

That's the deal with a single home server. It's fine until the day you're not there. The twin is a free Oracle Cloud VM that takes over by itself when the Pi goes quiet, and hands everything back when the Pi returns.

This post is the boring half, which is also the half people skip. Before a standby can take over anything, it has to be a complete copy of the Pi that **provably does nothing**. Getting there took four days, and then testing had to wait five more.

## Installed twice, run once

The first decision was the shape: active-passive, one leader at a time, never both.

Active-active sounds nicer and is a disaster here. The bot logs into Discord with one token. Two machines running it means every message I send gets two replies. Every cron job that posts a report would post it twice. So the rule I wrote down on 3 November was:

> Every job and every service asks "am I the leader?" before doing anything.

The VM gets the same scripts and the same services as the Pi. They're just installed there, not running. Installed twice, run once. Deciding who the leader is (a lock both machines can see) is part 2. Part 1 is making sure the twin is ready but can't misbehave while that doesn't exist yet.

## Oracle had no room, then my own script locked me out

Oracle's free tier includes Arm VMs, and I wanted one with 2 cores and 12 GB of RAM in the Mumbai region. The console said no:

```
Out of host capacity
```

That's a common answer for free Arm VMs. So I wrote a small script that creates the network once and then keeps trying to launch the VM, and ran it in the background. It got the VM on **try 72, at 01:42 on 5 November**.

Then SSH timed out.

The network had no internet gateway and an empty default route. The best explanation I have: the script's first run died halfway through setup, while my new API key was still spreading across Oracle's servers and returning errors. Every later run saw that the network already existed and skipped the gateway step. The VM was alive, in a room with no door.

Creating the gateway and the default route by hand fixed it. Later I rewrote the script so that every step checks its own piece instead of trusting that "the network exists" means "the network is complete". I haven't needed to run it again since, so the rewrite is untested. The lesson about setup scripts is one I keep re-learning: *exists* is not the same as *done*.

## Same user, same paths, on purpose

My scripts, services and notes are full of absolute paths like `/home/gaurav/...`. I could have made them all portable. Instead I made the VM look like the Pi: a user called `gaurav`, the same home directory, the same folder layout.

One thing didn't match. On the VM the `gaurav` user got ID 1002, because Oracle's image already had two users. On the Pi it's 1000. That turns out not to matter for file sync (files are owned by whoever runs the sync), so I left it.

## Syncthing, one way only

Files move with Syncthing, which already ran on the Pi for my notes. I added the VM as a device and shared four folders: my projects, my Claude settings and memory, my routine scripts, and my notes vault.

Three settings mattered:

- **Private network only.** The VM listens only on my Tailscale network. Global discovery, relays and NAT traversal are all off.
- **The VM is receive-only.** It gets the Pi's files and can't send anything back. Until there's a leader lock, the Pi is the only machine allowed to write.
- **Big rebuildable things stay out.** My animation folder, `node_modules`, virtual environments, build output and logs are all in the ignore list.

The first sync finished at **19:34 on 5 November**. It moved about 2.9 GB: 2.4 GB of projects, 417 MB of Claude settings, 6.1 MB of routines and 25 MB of notes, at roughly 0.6 MB/s, which is about what the Pi's upload manages.

### The plan said one thing, the ignore list said another

My plan said, firmly, that secrets never ride the file sync. Its example ignore list didn't contain a single secret pattern. If I had copied it as written, every `.env` file in my projects would have gone across.

So the real ignore file on both sides has these lines near the top:

```
// secrets travel via push-secrets.sh,
// never Syncthing
!.env.example
.env
.env.*
*.pem
*.key
```

After the first sync I searched the VM for `.env` files, keys and the Claude login file. It found zero. A rule only exists if a file enforces it.

## Rebuilding the runtimes instead of copying them

Virtual environments don't survive being copied between machines, which is why they're in the ignore list. On the VM I rebuilt them from the Pi's own `pip freeze`, so the package versions match.

One pin didn't fit. The VM runs Python 3.12 and the Pi runs 3.13. The Pi's list included `audioop-lts`, a package that only installs on Python 3.13 and newer, so I dropped it. After that every import worked.

Node came from nvm, at the same version as the Pi (v24.13.0), with a symlink at `/usr/local/bin/node` so scripts that call that path work the same. The Claude CLI went on at the same version the Pi had at the time, waiting for **its own login** (that happened on 11 November). I didn't copy the Pi's credentials file across. Two machines, two logins: if one leaks, I revoke one.

## Inert on purpose

This is the part that makes a standby safe. The service files for the bot and the other core services were copied onto the VM and left **disabled and stopped**. A disabled service doesn't start on boot, so even an Oracle reboot of the VM wouldn't bring a second bot to life. And the VM got **no crontab at all**, because without a leader check every scheduled job would double-post.

For a couple of hours there was a second safety net. The `.env` files weren't on the VM yet, so even a manual `systemctl start` would have failed.

That net vanished the moment I copied the secrets over. From then on the only thing between me and two bots on one token was the word `disabled`. I looked at masking the units, which makes them impossible to start. But masking works by putting a link to `/dev/null` in `/etc/systemd/system`, and that's exactly where the real unit files live. So I wrote it down as a known gap instead of pretending it was covered.

## Secrets: a list, a copy, and a hash check

Secrets don't sync. They move with a deliberately small script:

- `secrets.list` holds **paths only, no values**: 16 files on 6 November. The list can live in git, and the values never do.
- `push-secrets.sh` copies exactly those files to the other machine with `rsync`, every file set to mode `600`.
- `push-secrets.sh --check` hashes each file with `sha256sum` on both sides and prints only `same`, `differs` or `missing` for each path. It never prints a value.

On 6 November the check came back 16 out of 16 `same`. The list has grown since. Running the check again while writing this, all 18 entries say `same`.

The other door I closed was SSH from the internet. The VM's network rules started with port 22 open to the internet. I removed that rule, so the only rules left are two default ICMP error-message rules (not even ping), and every real connection goes over Tailscale. From the Pi today, a TCP connection to port 22 on the VM's public address doesn't get through.

## Then I froze everything

By the evening of 6 November the twin was complete apart from its Claude login: same files, same runtimes, same secrets, services installed and switched off. The obvious next step was the leader lock, then testing: pull the Pi's WiFi and watch the VM take over.

I didn't do it, because I was out of town until 11 November. If a test broke the Pi's network, nobody could get to it to fix it. That's the exact outage I was building this to survive, except this time I'd have caused it myself.

On the morning of 6 November I had already put a freeze notice at the top of the plan, with two lists:

- **Allowed:** building anything on the VM (installed disabled, never started), writing (not installing) the failover scripts, read-only commands on the Pi, and pushing secrets to the VM.
- **Waits until I'm back:** any change to the Pi's network, Tailscale, SSH, firewall or web server; restarting any Pi service; starting the bot or any core service on the VM; making Syncthing two-way; and every drill.

The rule under the lists: if a step needs one of those, stop and park it. Don't look for a workaround.

The freeze held until 23:16 on 11 November, when I was back next to the Pi and said "start testing".

## The short version

- **Active-passive, never active-active,** if anything shares a login or posts on a schedule.
- **Make the standby look like the original** (same user, same paths) instead of making everything portable.
- **Sync files one way** until something decides who the leader is.
- **Put your "secrets never sync" rule in the ignore file**, then check the far side for secrets anyway.
- **Rebuild runtimes from a freeze list**, and expect one or two pins to break across Python versions.
- **Move secrets by a list of paths** with a hash check that never prints values.
- **Write down what is still unsafe.** Mine was "only `disabled` stops a second bot".
- **Don't test failover on a machine you can't walk up to.**

Part 2 is the fun half: a leader lock that lives in a Discord channel, promote and demote scripts, and pulling the Pi's WiFi on purpose to see whether the VM really takes over.
