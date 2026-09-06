---
title: "Restarting a service from inside its own cgroup"
description: "systemctl restart from inside the unit does not fail. It succeeds, and it kills the process that asked. Those look identical from the shell and they are completely different problems."
date: 2026-09-06
category: tech
tags: ["systemd", "linux", "cgroups", "self-hosting", "raspberry-pi"]
draft: true
---

I asked a bot to restart itself. The command came back with nothing at
all — no output, no error, no exit status — and the service was already
back up.

Both of those are correct behaviour. Neither of them is what "restart
failed" looks like.

## Where you are standing

The bot runs as a systemd unit. It spawns a CLI, which spawns a shell,
which is where the command ran. Here is that shell asking which cgroup
it is in:

```
$ cat /proc/self/cgroup
0::/system.slice/discord-claude.service
```

Not a child of it. *It.* The whole family tree is flat:

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

Three generations — `python bot.py` → the CLI → `bash` — and every one
is a direct member of the same cgroup. The kernel's own accounting
agrees:

```
$ cat /sys/fs/cgroup/system.slice/\
discord-claude.service/cgroup.procs
157308
586476
587482
587503
```

So when that shell runs `systemctl restart discord-claude`, it is
asking systemd to tear down a group it is a member of.

## Why: two defaults, both reasonable

**Fork inheritance.** A process created by `fork()` starts life in its
parent's cgroup. Nothing in spawning a subprocess moves it out. You
have to move it deliberately, and neither the CLI nor the shell has any
reason to.

**`KillMode=control-group`.** This is the systemd default, and this
unit does not override it:

```
$ systemctl show discord-claude \
    -p KillMode -p KillSignal \
    -p Restart -p RestartUSec -p Delegate
KillMode=control-group
KillSignal=15
Restart=always
RestartUSec=15s
Delegate=no
```

Note that `KillMode` is *inherited*, not set. The unit file has no
`KillMode` line at all. The trap is in the defaults, which is the only
reason it is worth writing about.

`Delegate=no` matters too: nothing under this unit gets its own
sub-hierarchy, so there is no nesting to hide behind. Everything sits
flat in one group, and stopping the unit means SIGTERM to all of it.

## This is deterministic, not a race

It is tempting to read this as a timing problem — the restart got to
you before you got to finish — and to reach for `sleep 1`.

It is not a race. `KillMode=control-group` means the stop job's
definition of the unit is "every PID currently in this cgroup". You are
in the cgroup at the moment the job is enqueued. There is no interval
in which you are outside the set. Sleeping just moves *when* you die.

## But the restart worked

This is the part that reframes the whole problem, and it is the reason
"restart failed" is the wrong diagnosis.

`systemctl` is a client. It asks PID 1 over D-Bus to enqueue a job, and
then it waits for the result. Once the job is enqueued it belongs to
PID 1, and PID 1 is not in your cgroup. Killing the client does not
cancel the job any more than closing a browser tab cancels the order
you already placed.

So the restart completes. What you lose is the *caller*, and with it
everything the caller still had in flight: the reply it had not sent,
the remaining lines of the script, the exit status you were going to
check.

That distinction is the entire post. "The restart failed" and "the
process that asked for the restart no longer exists to see it succeed"
produce exactly the same silence at your terminal.

> **What I did not test.** This paragraph is reasoning from systemd's
> job model, not an experiment. Confirming it properly means creating a
> throwaway unit, restarting it from inside itself, and reading
> `NRestarts` and `ActiveEnterTimestamp` afterwards. I did not do that
> on this box, so treat the mechanism as argued rather than observed.

## The four things you are about to try

**`nohup` / `setsid` / `&`.** The reflex, and it does not help. None of
these change your cgroup. `nohup` detaches you from a terminal;
`setsid` gives you a new session and process group. The cgroup is a
different object from all three, and `KillMode=control-group` reads the
cgroup.

**`systemctl restart --no-block`.** Returns immediately instead of
waiting, which sounds like exactly the fix. The problem is that you are
now racing the stop job with the rest of your script, and it is a race
you generally lose — enqueueing is fast. Expect the next line not to
run. (I have not measured this one either; it is the same missing
scratch unit.)

**`KillMode=mixed`.** SIGTERM goes to the main process only, SIGKILL to
everything at the end. Your helper survives the TERM and then gets
killed anyway when the stop job finishes.

**`KillMode=process`.** This one does work, and systemd's own
documentation tells you not to use it, because processes left running
outside the unit's lifecycle are exactly the mess cgroups exist to
prevent. Two units on this box set it, and one of them is `sshd` — for
the specific reason that `systemctl restart ssh` over SSH should not
hang up on you. That is a deliberate exception, not a pattern.

## What to actually do

### 1. Just exit

This is the honest first answer and most posts skip it.

The unit above has `Restart=always` and `RestartUSec=15s`. A process
that wants to restart itself can simply stop. systemd notices and
brings it back fifteen seconds later. No transient units, no timers, no
dependencies, nothing to get wrong.

If your unit does not have a restart policy, adding one is a smaller
change than anything below it.

### 2. When exit is not enough

Exiting works when nothing is in flight. It does not work when the
process is holding something it must finish first — a reply it has been
asked for, a request it is mid-way through answering.

That is the case that actually came up here. On **2026-07-10** a config
change needed the bot to pick up a new flag, but the bot was mid-task.
The contemporaneous note records what was done:

```
Scheduled `systemctl restart discord-claude`
via transient systemd timer
(`restart-discord-claude-once`, +120 s) so the
running bot picks up the new flag — delayed so
the in-flight Claude task could reply first.
```

Two separate problems, two separate halves of the fix, and it is worth
being precise about which does what:

- **`systemd-run` solves the cgroup problem.** The transient unit it
  creates is a sibling in `system.slice`, not a descendant of the unit
  being restarted. The SIGTERM storm does not reach it.
- **The delay solves a different problem entirely.** It has nothing to
  do with cgroups. It exists so the in-flight work can land before the
  axe falls. The note says so in as many words.

Conflating those two is how this gets written up wrong. `systemd-run`
with no delay is enough to survive; the 120 seconds bought the reply.

The shape of the command:

```
$ systemd-run --collect \
    --on-active=120 \
    --unit=restart-discord-claude-once \
    systemctl restart discord-claude
```

> **Reconstructed, not transcribed.** The note records that a transient
> timer was used and that it was set to +120 s. It does not record the
> exact flags, `systemd-run` appears in no script anywhere on this box,
> and the journal only retains back to 2026-08-30, so the July event is
> out of retention. The interval is real. The command line above is my
> reconstruction of it.

`--collect` matters: without it the transient unit lingers in a failed
or inactive state and the name stays taken, so the next run needs a
different one.

### 3. Or restart from outside, permanently

The pattern that actually runs on this box does not restart from inside
at all. A separate watchdog unit does it:

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

and the last line of that script is, verbatim:

```bash
logger -t discord-claude-watchdog \
  "$reason -> restarting $UNIT"
systemctl restart "$UNIT"
```

That is the same command that killed the shell earlier. Here it is
completely safe, because `discord-claude-watchdog.service` is a sibling
unit in `system.slice` rather than a descendant of the unit it is
restarting.

Same command, same box, opposite outcome — decided entirely by where
the caller sits in the tree. If you want one thing from this post, that
is it.

## What the man pages say about this

Nothing, as far as I can find. I grepped the six pages you would
reasonably check on this machine:

```
systemctl                  0
systemd.kill               0
systemd-run                0
systemd.service            0
systemd.unit               0
systemd.resource-control   0
```

Zero hits for the self-restart case on `systemd 257
(257.9-1~deb13u1)`.

One honest qualification: the *sshd* version of this question — "why
does restarting ssh over ssh not drop me?" — is documented all over the
internet and answered well. That is a narrower case with its own
`KillMode=process` workaround baked into the shipped unit. The general
case, where your script is a grandchild of the unit it is restarting,
is the one I could not find written down.

## The short version

- You are in the cgroup. `cat /proc/self/cgroup` will tell you.
- `KillMode=control-group` is the default and it means "everything in
  the cgroup", including you.
- The restart still succeeds. PID 1 owns the job.
- Try exiting first, if the unit has `Restart=`.
- If something must finish first, `systemd-run --collect` puts the
  restarter in a sibling unit, and a delay — separately — buys time for
  the in-flight work.
- Better still, restart from a unit that was never inside in the first
  place.

---

*Verified on this box: Raspberry Pi 5, Debian 13 (trixie), `systemd 257
(257.9-1~deb13u1)`, cgroup v2 unified. Unit properties, cgroup
membership and the man-page sweep were re-run 2026-09-06. Two claims
are argued rather than observed and are marked as such above: that the
restart completes after the caller dies, and that `--no-block` loses
the race. The 2026-07-10 `systemd-run` command line is reconstructed
from a contemporaneous note that recorded the interval but not the
flags.*
