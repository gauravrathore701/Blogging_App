---
title: "My Raspberry Pi bot can't restart itself without killing the messenger"
description: "Run systemctl restart from inside a systemd unit and the restart should still go through, but the process that asked dies with the rest of the cgroup. Why, what doesn't help, and what does."
date: 2026-09-06
category: tech
tags: ["systemd", "linux", "cgroups", "self-hosting", "raspberry-pi"]
draft: true
---

I run a Discord bot on my Raspberry Pi as a systemd service, and it can run shell commands for me. On 10 July it needed a restart to pick up a config fix.

The obvious move was to have it run `systemctl restart discord-claude` itself. The problem: that shell lives *inside* the very service it would be restarting, so the command would kill the shell that typed it — along with the reply the bot was halfway through sending me. From the chat it would look like the restart silently failed. It almost certainly wouldn't have failed; the *messenger* would have been shot.

## You're standing inside the thing you're restarting

The bot runs as a systemd unit. It starts a CLI, which starts a shell, which is where commands run. Here's that shell asking which cgroup (systemd's process group) it belongs to, captured on 2026-09-04:

```
$ cat /proc/self/cgroup
0::/system.slice/discord-claude.service
```

Not a child group of the service. *The service itself.* And the whole family is flat:

```
$ systemd-cgls \
    /system.slice/discord-claude.service
CGroup /system.slice/discord-claude.service:
├─157308 .../venv/bin/python bot.py
├─586476 .../claude --output-format …
├─589399 /bin/bash -c source …
├─589421 systemd-cgls /system.slice/…
└─589422 head -8
```

Three generations — `python bot.py` → the CLI → `bash` — and every one of them is a direct member of the same group. The kernel's own list says the same thing. This was a separate capture, so the short-lived shell PIDs differ, but the bot (157308) and the CLI (586476) are the same:

```
$ cat /sys/fs/cgroup/system.slice/\
discord-claude.service/cgroup.procs
157308
586476
587482
587503
```

So when that shell runs `systemctl restart discord-claude`, it's asking systemd to tear down a group it's standing in. Like sawing off the branch you're sitting on, except the tree grows back and you don't.

## Two sensible defaults that team up against you

**Children inherit the cgroup.** A process started with `fork()` begins life in its parent's cgroup. Nothing about spawning a subprocess moves it out. You'd have to move it on purpose, and neither the CLI nor the shell has any reason to.

**`KillMode=control-group` is the default.** This unit doesn't override it:

```
$ systemctl show discord-claude \
    -p KillMode -p KillSignal \
    -p Restart -p RestartUSec -p Delegate
Restart=always
RestartUSec=15s
Delegate=no
KillMode=control-group
KillSignal=15
```

(Re-checked on 2026-09-17.) The unit file has no `KillMode` line at all — the value comes from systemd's default. That's what makes this a trap: nobody chose it.

`KillMode=control-group` means stopping the unit sends SIGTERM to *every* process in its cgroup. `Delegate=no` means nothing under the unit gets its own sub-group to hide in. Everything sits in one flat pile, and the stop hits all of it.

## `sleep 1` won't save you

It's tempting to see this as a timing problem — the restart got to you before you finished — and reach for a `sleep`.

It isn't a race. The stop is aimed at "every process in this cgroup", and you're in the cgroup the whole time. There's no moment where you're outside the target. Sleeping just changes *when* you get hit.

## The restart still worked (probably)

This is the bit that changes how you debug it.

`systemctl` is just a client. It asks PID 1 (systemd itself) over D-Bus to queue a restart job, then waits to hear how it went. Once the job is queued, it belongs to PID 1 — and PID 1 isn't in your cgroup. Killing the client doesn't cancel the job, any more than closing a browser tab cancels an order you already placed.

So the restart should still complete. What you lose is the *caller*, and everything it still had going: the reply it hadn't sent, the rest of the script, the exit status you meant to check.

"The restart failed" and "the thing that asked for the restart isn't around to see it succeed" look exactly the same from the terminal: silence.

> **What I didn't test.** This section is reasoning from how systemd's
> job model works, not an experiment. Proving it means creating a
> throwaway unit, restarting it from inside itself, and checking
> `NRestarts` and `ActiveEnterTimestamp` afterwards. I haven't done that
> on this Pi, so treat it as argued, not observed.

## Four things you'll try that don't really help

**`nohup`, `setsid`, `disown`, `&`.** The reflex, and none of them change your cgroup. `nohup` detaches you from the terminal; `setsid` gives you a new session and process group. The cgroup is a different thing from all of those, and `KillMode=control-group` only looks at the cgroup.

**`systemctl restart --no-block`.** Returns straight away instead of waiting, which sounds like exactly the fix. But now your script is racing the stop job, and systemd is quick. I'd expect the next line not to run. (Not measured either — same missing throwaway unit.)

**`KillMode=mixed`.** SIGTERM goes to the main process only; everything left in the cgroup gets SIGKILL once the main process is gone. Your helper dodges the TERM and then gets killed anyway.

**`KillMode=process`.** This one does protect you — only the main process gets killed. But systemd's own `systemd.kill` man page labels it "not recommended!", because leftover processes running outside the service's lifecycle are exactly the mess cgroups exist to prevent. Plenty of packaged services set it anyway — on this Pi that includes `ssh`, `cron`, `NetworkManager` and `docker`. Those are deliberate exceptions by their maintainers, not a pattern to copy into your own unit.

## Three ways to restart without shooting yourself

### 1. Just exit

The honest first answer, and most write-ups skip it.

This unit has `Restart=always` and `RestartUSec=15s`. A process that wants to restart can simply exit, and systemd brings it back fifteen seconds later. No extra units, no timers, nothing to get wrong.

If your unit has no restart policy, adding one is a smaller change than anything below.

### 2. Hand the restart to someone outside — with a delay if you need one

Exiting is fine when nothing's in flight. It's not fine when the process is in the middle of something it has to finish — like a reply it's been asked for.

That's exactly what happened on **2026-07-10**. A config fix needed the bot to restart, but the bot was mid-task. My note from that night:

```
Scheduled `systemctl restart discord-claude`
via transient systemd timer
(`restart-discord-claude-once`, +120 s) so the
running bot picks up the new flag — delayed so
the in-flight Claude task could reply first.
```

There are two separate problems here, and the fix has two halves. It's worth being precise about which does what:

- **`systemd-run` fixes the cgroup problem.** The temporary unit it creates sits next to the bot in `system.slice`, not inside it. The SIGTERM doesn't reach it.
- **The delay fixes something else entirely.** It has nothing to do with cgroups. It's there so the in-flight reply can land before the restart hits. The note says so directly.

Mixing those two up is how this gets explained wrong. `systemd-run` with no delay is enough to *survive*; the 120 seconds bought the *reply*.

The command looks roughly like this:

```
$ systemd-run --collect \
    --on-active=120 \
    --unit=restart-discord-claude-once \
    systemctl restart discord-claude
```

> **Reconstructed, not copied.** The note records a transient timer
> set to +120 s. It doesn't record the exact flags, and the Pi's
> journal no longer goes back to July, so there's nothing to check it
> against. The interval is real; the command line above is my
> reconstruction.

`--collect` matters. Without it, a run that *fails* stays loaded in the failed state until someone resets it, and the unit name stays taken — so the next attempt with the same `--unit=` name won't start.

The same bot has since picked up this pattern in its own code. A later command that does something drastic schedules it through `systemd-run --collect --on-active=…` instead of calling `systemctl` directly, and the code comment explains why: a direct call would kill the bot mid-reply, *"because the bot lives inside its own unit's cgroup."*

### 3. Or never restart from inside at all

The pattern that runs on this Pi day to day doesn't restart from inside. A separate watchdog unit does it:

```ini
[Unit]
Description=Restart discord-claude if its
  heartbeat is stale
After=discord-claude.service

[Service]
Type=oneshot
ExecStart=/home/gaurav/Projects/\
discord-claude-bot/watchdog.sh
```

And the last lines of that script, word for word:

```bash
logger -t discord-claude-watchdog \
  "$reason -> restarting $UNIT"
systemctl restart "$UNIT"
```

That's the exact command that would have killed the bot's own shell. Here it's completely safe, because `discord-claude-watchdog.service` is a neighbour in `system.slice`, not something living inside the unit it restarts.

Same command, same Pi, opposite outcome — decided entirely by where the caller sits in the tree. If you take one thing from this post, take that.

## The man pages don't spell this out

As far as I can find, they don't. I searched the six pages you'd reasonably check, on this Pi, for phrasings like "own control group", "its own cgroup", "restart itself" and "kill … caller":

```
systemctl                  0
systemd.kill               0
systemd-run                0
systemd.service            0
systemd.unit               0
systemd.resource-control   0
```

Zero hits on `systemd 257 (257.9-1~deb13u1)`, first on 2026-09-06 and again on 2026-09-17. Every individual fact is in there somewhere — cgroup membership, the `KillMode` default, what `systemd-run` does — but nobody joins them up.

To be fair: the *ssh* version of this question ("why doesn't restarting ssh over ssh drop me?") is answered all over the internet, and answered well. That's a narrower case with its own `KillMode=process` baked into the shipped unit. The general case — your script is a grandchild of the unit it's restarting — is the one I couldn't find written down.

## The whole post in six bullets

- You're probably in the cgroup. `cat /proc/self/cgroup` will tell you.
- `KillMode=control-group` is the default, and it means "everything in the cgroup", including you.
- The restart itself should still go through. PID 1 owns the job.
- Try exiting first, if the unit has `Restart=`.
- If something has to finish first, `systemd-run --collect` puts the restarter outside the cgroup, and a delay — separately — buys time for the in-flight work.
- Best of all, restart from a unit that was never inside in the first place.

---

*Checked on this Pi: Raspberry Pi 5, Debian 13 (trixie), `systemd 257 (257.9-1~deb13u1)`, cgroup v2. The cgroup membership output was captured on 2026-09-04. Unit properties, the watchdog unit and script, the `KillMode=process` units and the man-page search were re-checked on 2026-09-17. Two claims are argued rather than observed and are marked above: that the restart completes after the caller dies, and that `--no-block` loses the race. The 2026-07-10 command line is reconstructed from a note that recorded the interval but not the flags.*
