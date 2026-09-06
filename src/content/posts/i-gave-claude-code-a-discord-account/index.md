---
title: "I gave Claude Code a Discord account"
description: "Fifteen months running a coding agent as a chat bot on a Raspberry Pi. The hard parts were not the model — they were prompt composition, directory routing, timeouts, and proving it was alive."
date: 2026-09-06
category: tech
tags: ["claude-code", "discord", "agents", "python", "self-hosting"]
draft: true
---

Somewhere around month two I stopped adding features to this bot and
started adding rules.

The longest instruction in its prompt is not about what it can do. It
is a list of things it must ask about before deleting: files and
directories, git history, database rows, systemd units, config blocks,
cron entries, Docker volumes, remote resources. It ends with a line I
had to write after watching it be *helpful*:

> If something merely LOOKS unused, leave it and say so — do not tidy
> up on your own initiative.

That sentence is the honest summary of this project. Giving a coding
agent a chat account turns out to be an operations problem, not an AI
problem.

## What it actually is

A Python process using `discord.py`, running as a systemd unit on a
Raspberry Pi 5. A message arrives in an allowlisted channel from an
allowlisted user; the bot shells out to the Claude Code CLI in
non-interactive mode, waits, and posts what comes back.

That is the whole architecture. Everything interesting is in the
details around it, and none of the details are about the model.

## Channels are identities, not rooms

The first real design decision was that per-channel configuration
should shape the *prompt*, not just the routing.

There is a shared set of instructions injected into every prompt —
nine of them today, keyed by name so a channel can drop individual ones:

```
session   recall     internet
history   profile    personality
restart   delete     discord_format
```

Each channel has its own `notes` appended to that base, and two escape
hatches: `omit`, which drops named keys, and `replace_points`, which
ignores the shared set entirely and uses only the channel's own notes.

The effect is that each channel is a different working agreement with
the same model. One is pinned to a single repository with a longer
timeout. One is a writing channel with rules about evidence and tone
that would be actively unhelpful anywhere else. The blog channel — the
one that produced this post — carries a content pipeline it is not
allowed to skip.

I did not design that. It accreted, because every time the bot did
something reasonable-but-wrong in one context, the fix belonged to that
context and nowhere else.

The `discord_format` key is the least glamorous and the one I would
port to any other project immediately. It is a description of the
screen the answer will be read on: a phone, roughly 45 monospace
characters wide before a code block starts scrolling sideways, no
markdown tables because Discord does not render them. Output formatting
is not a cosmetic concern when the medium is fixed and narrow. It
changes what a good answer *is*.

## Routing a message to a directory

An agent that can run commands needs to know where. The rule is that a
message beginning `projectname:` runs in that project directory:

```python
m = re.match(
    r'^([\w][\w\-_.]*)\s*:\s*(.+)$',
    content, re.DOTALL)
if m:
    name, task = m.group(1), m.group(2).strip()
    candidate = os.path.join(base_dir, name)
    if os.path.isdir(candidate):
        return candidate, task
```

That is user input becoming a filesystem path, which is the shape of a
great many bad afternoons, so I went back and tested it properly rather
than assuming:

```
'..: ls'           -> NO MATCH
'a/..: ls'         -> NO MATCH
'../..: ls'        -> NO MATCH
'a/../../etc: ls'  -> NO MATCH
'_..: ls'          -> isdir=False
'bloging-app: hi'  -> isdir=True
```

It holds, for two independent reasons. The character class
`[\w\-_.]` contains no `/`, so no path separator can ever appear in the
captured name. And the first character must be `[\w]`, so a bare `..`
cannot match at all. Anything that does match resolves to a literal
directory name inside the projects root, and `os.path.isdir()` gates it
from there.

I would rather be accurate than flattering about this: **it is safe by
construction, not by intent.** I wrote a regex to describe project
names and it happens to exclude traversal as a side effect. The robust
version is one more line — resolve the candidate with
`os.path.realpath()` and check it is still under the base directory —
and it does not depend on a character class staying exactly as it is
through future edits. If you are copying this pattern, copy that line
too.

## Timeouts are the actual design problem

A chat client expects a reply in seconds. A build takes twenty minutes.
Nothing about Discord's interaction model has an opinion about which
one you are doing.

The default task timeout in the code is 1200 seconds, with per-channel
overrides — a channel doing long log analysis gets twenty-five minutes
while others cap lower. When the timeout fires, the process is killed
outright.

Two things I learned the boring way.

**Say what the timeout is.** A `!status` command that prints the
resolved timeout, and whether it came from the channel or the default,
removed an entire category of "is it stuck or is it thinking" messages.

**Doc drift is real and it is embarrassing.** Writing this post I found
that the code's fallback is `1200`, while the example environment file,
the README and the project's own instructions file all say `600`. Both
are "true" — copy the example and you get 600, leave it unset and you
get 1200 — but the documentation describes the default incorrectly, and
has for a while. I found it by counting things for a blog post, which
is not a maintenance strategy.

## Proving it is alive

This is where most of the real engineering went, and it has produced
two separate stories that do not fit here.

The short version: the bot went dark for seven hours once while its
health check reported perfect health, because the heartbeat was
checking a different transport from the one carrying the work. And
asking the bot to restart itself does not work the way you would
expect, because the shell it runs commands in is a member of the same
control group as the service being restarted.

Both of those are their own posts. I mention them here only because
"can it do the task" turned out to be a much smaller problem than "can
I tell, right now, whether it is able to".

## The part I have to be honest about

The bot runs the CLI with permission prompts disabled. It has a real
shell on a machine that hosts real services.

The mitigations, all of which are load-bearing and none of which are
clever:

- A hardcoded allowlist of Discord user IDs. One entry.
- An allowlist of channel IDs. Messages anywhere else are ignored.
- It runs as an unprivileged user, not root.
- Each channel is pinned to a working directory.
- A hard timeout with an actual `proc.kill()`.

And then the rules — the deletion rule at the top of this post, a rule
about never restarting the service without confirmation, a rule about
asking before anything outward-facing.

Those rules are **not a security control**. I want to be unambiguous
about that, because it is the easiest thing in this whole setup to be
sloppy about. They are a politeness control. They make a
well-intentioned agent behave carefully. They would do nothing at all
against a message crafted to get around them. Anyone who can get a
message into an allowlisted channel as an allowlisted user has a shell
on my Pi, and the only thing standing in front of that is Discord's
authentication and the fact that nobody knows the channel exists.

Obscurity is doing more work in that sentence than I am comfortable
with. That is a real finding about this design and not a confession I
am making for effect.

## What changed once it could run real commands

The thing I did not anticipate is that the value stopped being code
generation almost immediately.

What it became useful for is *reading the machine's own history before
answering*. There is a rule in the shared prompt requiring a markdown
note in a project's history folder after any significant change. Fifteen
months in, those notes are the reason the bot can answer questions like
"why is this configured this way" — not because the model knows, but
because a previous session wrote down what it did and when, and this
session can go and read it.

That has a sharp edge, and the blog channel is where I found it. Every
research task I have run against my own infrastructure has overturned at
least one thing I confidently believed about it. A cron job I was sure
had created repositories behind my back had done no such thing. A delay
I remembered as twenty seconds was a hundred and twenty. A count of
eight was ten, or eleven.

An agent with a shell and a filing habit is not primarily a faster way
to write code. It is a way to be corrected by your own machine, which
is a thing I did not know I wanted and now would not give up.

---

*Running on a Raspberry Pi 5, Debian 13, as a systemd unit. Counts in
this post were taken 2026-09-06 and will drift — the shared instruction
set was nine keys on that date, and has been eight and ten at other
times. Deliberately absent: any Discord ID, invite, guild or bot name,
any environment values, the watchdog's thresholds, and any inventory of
what else runs on this machine. No uptime or cost figure appears here
because neither has been measured to a standard I would publish.*
