---
title: "My Raspberry Pi bot can't restart itself without killing the messenger"
description: "I asked a bot to restart itself. Linux shuts down a program and everything it launched together, so the bot died mid-sentence. Why that happens, in plain words, and three ways around it."
date: 2026-09-06
updated: 2026-10-06
category: tech
tags: ["systemd", "linux", "cgroups", "self-hosting", "raspberry-pi"]
draft: false
---

I run a Discord bot on my Raspberry Pi. It sits there all day, and when I message it, it can run commands on the Pi for me. On 10 July it needed a restart to pick up a config fix.

The obvious move was to ask the bot to restart itself. The problem is that the bot would be issuing the shutdown order from *inside* the thing being shut down. The order goes out, the bot gets taken down with everything else, and the half-written reply it owed me never arrives. From my phone it looks like the restart silently failed. It almost certainly didn't fail — the messenger just got shot.

## The short version, if you're not a Linux person

Linux has a manager that starts background programs when the machine boots and keeps them alive. On most modern systems that manager is called **systemd**, and each program it looks after is a **service**.

When systemd starts a service, it drops that program into a labelled box. Anything the program launches afterwards — a helper, a script, a command — lands in the same box automatically. The box exists so systemd can clean up properly: when you say "restart this service", it empties the whole box and starts fresh. No stragglers left behind.

That's a good design, and it's exactly the problem. My bot was in the box. The shell running my command was in the box. So "empty the box" included the thing asking for the box to be emptied.

The box has a real name — a **cgroup**, short for control group — and the rest of this post is about seeing it, confirming it's the cause, and getting the order issued from outside it.

## You're standing inside the thing you're restarting

The bot runs as a systemd service. It starts a command-line tool, which starts a shell, and the shell is where my commands actually run. Three programs, one after the other.

Every program on Linux can ask which box it's in. Here's that shell asking, captured on 2026-09-04:

```
$ cat /proc/self/cgroup
0::/system.slice/mybot.service
```

Read that answer as "I am in the box belonging to `mybot.service`". Not a smaller box tucked inside it. The service's own box.

You might hope the helpers at least sit in some nested compartment, where a shutdown aimed at the main program would miss them. They don't. Here's the whole family listed out:

```
$ systemd-cgls \
    /system.slice/mybot.service
CGroup /system.slice/mybot.service:
├─157308 .../venv/bin/python bot.py
├─586476 .../claude --output-format …
├─589399 /bin/bash -c source …
├─589421 systemd-cgls /system.slice/…
└─589422 head -8
```

Three generations — the bot itself, then the CLI it started, then the shell — and all of them are listed flat, as direct members of one box. The numbers on the left are process IDs, Linux's way of naming each running program.

The kernel's own membership list agrees. This was a separate capture, so the short-lived shell IDs are different, but the bot (157308) and the CLI (586476) are the same two:

```
$ cat /sys/fs/cgroup/system.slice/\
mybot.service/cgroup.procs
157308
586476
587482
587503
```

So when that shell asks for the service to be restarted, it is asking for the teardown of a box it is standing in. Like sawing off the branch you're sitting on — except the tree grows back and you don't.

## Two sensible defaults that team up against you

Neither of these is a bug. Each one is the right call on its own. Together they're a trap.

**Helpers inherit the box.** When a program launches another program, the new one starts life in its parent's box. Nothing about being a child moves you out. You'd have to move yourself out deliberately, and neither the CLI nor the shell has any reason to.

**"Shut down everything in the box" is the default.** The setting is called `KillMode`, and my unit never sets it, so it gets systemd's default:

```
$ systemctl show mybot \
    -p KillMode -p KillSignal \
    -p Restart -p RestartUSec -p Delegate
Restart=always
RestartUSec=15s
Delegate=no
KillMode=control-group
KillSignal=15
```

(Re-checked on 2026-09-17.) In plain words, that output says: shut down *every* program in the box (`KillMode=control-group`); ask politely first rather than force-killing (`KillSignal=15` is the "please exit" signal); don't give anything its own sub-box to hide in (`Delegate=no`); and if this service stops for any reason, bring it back 15 seconds later (`Restart=always`, `RestartUSec=15s`).

That last line matters later. Keep it in mind.

The reason this catches people is that nobody chose it. There's no `KillMode` line in my unit file to go and find. The behaviour arrives by default.

## `sleep 1` won't save you

The instinct is to read this as a timing problem — the shutdown reached me before I finished talking — and reach for a short pause.

It isn't a race. The shutdown isn't aimed at a moment, it's aimed at a place: *every program in this box*. You are in the box for the whole duration. There is no instant at which you're standing somewhere else. Waiting just moves when you get hit.

## The restart still worked (probably)

This is the bit that changes how you debug it.

The `systemctl` command you type isn't the thing doing the work. It's a messenger. It hands a request to systemd itself — the very first program the machine starts, which outlives everything else — and then waits around to report back how it went.

Once that request has been accepted, it belongs to systemd, and systemd is not in your box. Killing the messenger doesn't cancel the request, any more than closing a browser tab cancels an order you already placed.

So the restart should still go through. What you lose is the *caller* and everything it still had pending: the reply it hadn't sent, the rest of the script, the result it meant to check.

Which leaves you with two very different situations that look identical from the outside:

- the restart failed, and
- the restart worked, but nobody who cared about it is still around to see.

Both look like silence.

> **What I didn't test.** This section is reasoning from how systemd
> hands out and owns jobs, not an experiment. Proving it means creating
> a throwaway service, restarting it from inside itself, and then
> checking its restart counter and start timestamp afterwards. I
> haven't done that on this Pi, so treat it as argued, not observed.

## Four things you'll try that don't really help

**`nohup`, `setsid`, `disown`, `&`.** These are the usual tools for cutting a command loose so it survives after you walk away, and they're the first thing everyone reaches for. None of them move you to a different box. They detach you from the terminal, or give you a fresh session — real things, just not *this* thing. The shutdown only looks at the box.

**`systemctl restart --no-block`.** This tells the messenger not to wait around for the answer, which sounds like precisely the fix. But your script is now racing the shutdown, and systemd is quick. I'd expect the next line never to run. (Also not measured — same missing throwaway service.)

**`KillMode=mixed`.** This politely asks only the main program to exit, then force-kills whatever is still in the box once it's gone. Your helper dodges the polite request and gets force-killed a moment later. Worse, not better.

**`KillMode=process`.** This one genuinely does protect you: only the main program is shut down, and the rest of the box is left alone. But systemd's own documentation labels it "not recommended!", because stray programs outliving the service they belong to are the exact mess that boxes exist to prevent.

Plenty of packaged services set it anyway — on this Pi that includes `ssh`, `cron`, `NetworkManager` and `docker`. (This is why restarting SSH over SSH doesn't drop you: that unit opts out.) Those are deliberate exceptions, chosen by people who maintain those programs for a living. Not a pattern to copy into your own unit because it made one annoyance go away.

## Three ways to restart without shooting yourself

### 1. Just exit

The honest first answer, and most write-ups skip it.

Remember `Restart=always` and `RestartUSec=15s` from that output earlier. They mean: if this service stops for any reason at all, start it again 15 seconds later. So a program that wants to be restarted doesn't need to issue any order. It can simply stop, and the manager brings it back.

No extra pieces, nothing to get wrong. If your service has no restart policy, adding one is a smaller change than anything below.

### 2. Hand the job to someone standing outside

Exiting is fine when nothing is in flight. It's not fine when the program is in the middle of something it has to finish — like a reply it has been asked for and hasn't sent.

That's exactly the situation on **2026-07-10**. A config fix needed the bot restarted, but the bot was mid-task. My note from that night:

```
Scheduled `systemctl restart mybot`
via transient systemd timer
(`restart-mybot-once`, +120 s) so the
running bot picks up the new flag — delayed so
the in-flight Claude task could reply first.
```

So: instead of giving the order myself, I asked systemd to create a tiny throwaway service whose only job was to give the order, two minutes later.

There are two separate problems being solved there, and it's worth being precise about which half does what, because this is where the explanation usually goes wrong:

- **The throwaway service fixes the box problem.** systemd creates it *next to* the bot rather than inside it, so the shutdown never reaches it.
- **The two-minute delay fixes something else entirely.** It has nothing to do with boxes. It's there so the reply in flight can land first. My note says exactly that.

Standing outside the box is what makes you *survive*. The 120 seconds bought the *reply*. One without the other solves half the problem.

The command looks roughly like this:

```
$ systemd-run --collect \
    --on-active=120 \
    --unit=restart-mybot-once \
    systemctl restart mybot
```

> **Reconstructed, not copied.** My note records a throwaway timer set
> to +120 s. It doesn't record the exact flags, and the Pi's logs no
> longer reach back to July, so there's nothing left to check it
> against. The interval is real; the command line above is my
> reconstruction.

One flag there is worth knowing about. `--collect` tells systemd to tidy the throwaway service away afterwards. Without it, a run that *fails* hangs around in a failed state until someone clears it by hand — and while it's there, the name is taken, so your next attempt using the same name won't start at all.

The bot has since learned this pattern itself. A command in its code that does something drastic now schedules the work through a throwaway service instead of running it directly, and the comment next to it says why: a direct call would kill the bot mid-reply, *"because the bot lives inside its own unit's cgroup."*

### 3. Or never restart from inside at all

The pattern that actually runs on this Pi day to day doesn't restart from inside. A separate little service does it, and that service checks whether the bot is still alive:

```ini
[Unit]
Description=Restart mybot if its heartbeat is stale
After=mybot.service

[Service]
Type=oneshot
ExecStart=/path/to/watchdog.sh
```

And here are the last two lines of that script, word for word:

```bash
logger -t mybot-watchdog \
  "$reason -> restarting $UNIT"
systemctl restart "$UNIT"
```

That last line is the *exact* command that would have killed the bot's own shell. Here it's completely safe — because the watchdog is its own service, a neighbour of the bot rather than a resident of its box.

Same command, same Pi, opposite outcome, decided entirely by who's holding it. If you take one thing from this post, take that.

## The manuals don't join the dots

As far as I can find, they don't say this anywhere. I searched the six manual pages you'd reasonably check, on this Pi, for phrasings like "own control group", "its own cgroup", "restart itself" and "kill … caller":

```
systemctl                  0
systemd.kill               0
systemd-run                0
systemd.service            0
systemd.unit               0
systemd.resource-control   0
```

Zero hits on `systemd 257 (257.9-1~deb13u1)`, first on 2026-09-06 and again on 2026-09-17. Every individual fact is in there somewhere — that helpers inherit the box, that shutting down means shutting down the whole box, what the throwaway-service tool does. Nobody puts them next to each other and says what happens.

To be fair, the narrow version of this question — "why doesn't restarting SSH over SSH disconnect me?" — is answered all over the internet, and answered well. That case has the opt-out baked into the shipped unit, as we saw. The general case, where your script is a grandchild of the service it's restarting, is the one I couldn't find written down.

## The whole post in six bullets

- You're probably inside the box. `cat /proc/self/cgroup` will tell you.
- Shutting a service down means shutting down everything in its box, including whoever asked.
- The restart itself should still happen. The manager owns that job, and the manager isn't in your box.
- Try just exiting first, if your service has a restart policy.
- If something has to finish first, have a throwaway service outside the box give the order — and add a delay, separately, to buy time for the work in flight.
- Best of all, give the order from something that was never inside in the first place.

---

*Checked on this Pi: Raspberry Pi 5, Debian 13 (trixie), `systemd 257 (257.9-1~deb13u1)`, cgroup v2. The cgroup membership output was captured on 2026-09-04. Unit properties, the watchdog unit and script, the `KillMode=process` units and the man-page search were re-checked on 2026-09-17. Two claims are argued rather than observed and are marked above: that the restart completes after the caller dies, and that `--no-block` loses the race. The 2026-07-10 command line is reconstructed from a note that recorded the interval but not the flags.*
