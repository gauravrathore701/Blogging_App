---
title: "My backup script took a 0600 secret and wrote it into a 0644 file"
description: "I went looking for a cron job that was creating GitHub repos behind my back. It never did. What it was actually doing was quieter, and it had already been cleaned up once."
date: 2026-09-06
category: tech
tags: ["automation", "security", "cron", "git", "self-hosting"]
draft: true
---

Here are three files on my Raspberry Pi, side by side:

```
$ stat -c '%A %n' ~/.github_token \
    ~/Projects/bloging-app/.git/config \
    ~/Projects/mongo-pi/.git/config
-rw------- .../.github_token
-rw-r--r-- .../bloging-app/.git/config
-rw-rw-r-- .../mongo-pi/.git/config
```

The first one is a GitHub personal access token. I set those
permissions on purpose. The other two are files an unattended job wrote
a copy of that token into, at eight in the morning, while I was asleep.

It logged nothing about it, because that branch of the script has no
log statement in it.

That is not the thing I set out to investigate.

## The wrong question

What I actually believed was that my daily sync script had been
creating GitHub repositories without being asked. I had a memory of
repos appearing that I did not remember making, and a script that
plainly contained `gh api user/repos`, and that was enough to convince
me.

It is wrong, and the logs say so immediately.

The job runs from cron:

```
0 8 * * * /home/gaurav/routines/git_sync.sh \
  >> .../logs/git_sync_cron.log 2>&1
```

There are 78 per-day log files, 2026-06-20 through 2026-09-05, with no
missing day. The first line of the cron log is:

```
[08:00:01] ===== Git Sync Start
           2026-06-21 08:00 =====
```

So cron's first run was **2026-06-21**. Every repository I was
suspicious about was created on **2026-06-20**, between 11:45:43 and
11:47:32 — six of them, inside a single run that lasted one minute and
forty-nine seconds. I can line the GitHub creation timestamps up
against the log lines that announced each folder, and they land three
to twenty-one seconds apart, in order.

That was me. I ran it by hand, in the foreground, sixteen minutes after
installing `gh` on the box.

The unattended job did reach the create path, twice, months later. Both
times the creation **failed**. Both of those repositories return 404
today.

So the count of GitHub repositories created by a job running without me
is zero. I had been carrying a false story about my own machine for two
months, and I would have published it if I had written the post I
originally intended to write.

## What the job is allowed to do to a folder it has never seen

The interesting question turned out to be a different one: *what list
does this thing work from?*

It does not have a list. It has a glob.

```bash
for dir in "$PROJECTS_DIR"/*/; do
  name=$(basename "$dir")
```

`PROJECTS_DIR` is `/home/gaurav/Projects`. Membership in the set of
things this job acts on is decided by the filesystem, at 08:00, with
nobody present. And `name` — the directory name, whatever it happens to
be — is used directly as the GitHub repository name later on. Nothing
validates or normalises it.

Here is what a brand-new folder got:

```bash
if [ ! -d "$dir/.git" ]; then
  log "$name: not a git repo — initializing"
  ensure_gitignore "$dir"
  git -C "$dir" init -q
  git -C "$dir" checkout -b develop -q
  git -C "$dir" add -A
  ...
  GH_TOKEN=$GH_TOKEN gh api user/repos \
    -f name="$name" \
    -f private=true \
    --silent 2>&1 | grep -v "^$" \
    | grep -v "already exists" || true

  git -C "$dir" remote add origin \
    "$(https_url "$name")"
```

`git init`, a commit whose message was written by an AI, a private
repository on my account, and a push. Eleven lines, no confirmation
step, and a folder that had existed for a few hours as the only input.

Note the error handling. The `gh api` call ends in `|| true`, and its
stderr is funnelled through two `grep -v`s before being thrown away.
The API error that would have explained everything — every morning, for
months — was deliberately swallowed.

## "The next morning at 08:00"

Three folders, three mornings, one behaviour:

```
folder        appeared      first run
api-nexus     06-22 16:18   06-23 08:00
mongo-pi      07-15 15:10   07-16 08:00
bloging-app   09-02 00:49   09-02 08:00
```

Gaps of roughly sixteen hours, seventeen hours, and seven hours. You
create a directory in the afternoon; by breakfast it has a git history,
a branch, and an attempted home on the internet.

The near-miss is the one that made me stop. `pi-infra` — a folder of
sanitised Caddy, cloudflared and systemd configuration — was born at
**08:13:31** on 2026-09-02, fourteen minutes *after* that morning's run
had finished. It went onto a skip list at 08:20:01, six minutes later,
and I deleted the create path three minutes after that.

Without either change, the next morning's run would have met a folder
full of infrastructure config with no `origin` and done the obvious
thing with it. The note I wrote at the time says exactly that.

Six minutes. And only because I happened to be reading the sync script
that morning for unrelated reasons.

## The part that actually mattered

It was never the repositories.

For `bloging-app`, three independent artefacts agree to the second.
The reflog:

```
b832a39 develop@{2026-09-02 08:00:01 +0530}:
  branch: Created from HEAD
```

The file's modification time:

```
2026-09-02 08:00:01.700300818
  .../bloging-app/.git/config
```

And the day's log, which is the entire record of what happened to that
folder:

```
[08:00:01] --- bloging-app ---
[08:00:01] bloging-app: creating develop
           from master
[08:00:02] bloging-app: ERROR — push failed
```

Read those three lines again and notice what is missing. There is no
mention of a remote being added. The script built a URL of the form
`https://<token>@github.com/<user>/<name>.git` and wrote it into
`.git/config`, and said nothing, because that code path contains no
`log` call at all.

The only reason the event can be dated is the file's mtime.

## It had already been fixed once

This is the sentence the post exists for.

On **2026-06-29**, the same token was found embedded in the
`.git/config` of seven other repositories on this box. All seven were
switched to SSH remotes that day. The cleanup held — they are all still
SSH.

The follow-up I wrote down at the time was that the exposed token
should be revoked and rotated.

Sixty-five days later, the automation put the same credential back, in
a new file, on a folder that had not existed in June.

I did not change the script in between. I fixed the *state* and left
the *generator* running, and the generator does not care what I cleaned
up last time. That is the whole lesson, and it generalises well past
this script: **a cleanup is a state change; an unattended job is a
state machine that runs every day.** If the two disagree, the one with
a cron entry wins.

As of 2026-09-06 I have now done the same cleanup a second time. A scan
of every `.git/config` under `~/Projects` finds no token-bearing remote
in any of them. The exposure was 2026-09-02 to 2026-09-05 for one repo
and 2026-07-16 to 2026-09-05 for the other, on a single-user machine
where nothing served those paths to the network — real, contained, and
not the kind of thing I want to find twice.

On rotation: `~/.github_token`'s mtime is still 2026-06-20 11:42:59 and
has not moved. That is what "never rotated" looks like from this side.
I cannot prove a negative from a file timestamp, but I also cannot
think of a rotation that leaves one.

## Why none of this was visible

Four reasons, and all four transfer to other unattended jobs:

**The dangerous branch was the rare branch.** The path that adds a
remote ran on three folders, ever, across 83 runs. The other 80 runs
did the boring thing correctly.

**The dangerous branch was the quiet branch.** Every other action in
the script logs. This one does not.

**The visible symptom was in a different category from the cause.**
What showed up daily was `ERROR — push failed`, which reads as a
network or permissions problem. It is red, it is unmissable, and it
sent me looking at the wrong layer for weeks. The actual event — a
credential being relocated — produced no line at all.

**The guard that existed worked perfectly.** `ensure_gitignore()`
appends `.env`, `*.env`, `secrets.*`, `*.key`, `*.pem` and friends
before the first `git add -A`, and it did its job: `mongo-pi/.env`,
which holds database credentials, is not in that commit. I had thought
carefully about secrets leaving.

The secret that moved that morning was one coming *in*. A guard that
works is exactly the condition under which people stop looking.

## Whitelist, blacklist, glob

There are three ways an unattended job can decide what to act on, and
the difference between them is not really about safety. It is about
*when you have to be right*.

- **A whitelist** asks you to be right at the moment you create a
  project — when the whole context is in your head. Its failure mode is
  omission: something silently does not get backed up, and you find out
  when you need the backup.
- **A blacklist** asks you to be right about projects that do not exist
  yet, at a moment when you are thinking about something else entirely.
  Its failure mode is commission.
- **A bare glob** is a blacklist whose list is empty. Same failure
  mode, and no place to write the exception even if you think of one.

`pi-infra` is the proof. It needed to be defended fourteen minutes
after it existed, and it was, with six minutes to spare, by luck.

Now the honest counter-argument, because the post is worthless without
it: **this job's entire purpose is to catch the thing I forgot to set
up.** A whitelist defeats it completely. If I could be relied upon to
add a project to an allow-list, I could be relied upon to `git init`
it, and then I would not need the job.

The resolution is that "act on everything" and "act *irreversibly* on
everything" are two different permissions, and they can be separated.
The glob stays. What changed is the ceiling on what the job may do to a
folder it has never seen: commit locally — reversible, local, free —
and report. That is a better fix than an opt-out list, and it keeps the
reason the job exists.

## Why "create if missing" is not `mkdir -p`

`mkdir -p` is fine. `CREATE TABLE IF NOT EXISTS` is fine. So what makes
`gh api user/repos` on a missing remote different?

**The resource is outside the blast radius you can see.** A directory
lives on the disk you are already writing to. A repository lives on
someone else's system, under an account with a quota, a billing
relationship and a public surface. "If missing, create" quietly
promotes a local decision into a remote one.

**The name is accident-controlled.** It is `basename "$dir"`. Anything
that can put a directory into `~/Projects` — an unpack, a clone of
someone else's project, a stray `cp -r`, an agent — picks a name in a
namespace I own.

**The inverse is not symmetric.** Creating is one API call. Un-creating
is a decision, a confirmation dialog, and a judgement about whether
anything already pushed ever leaked.

The Google Cloud incident that deleted a pension fund's account in 2024
is the same shape, inverted: a parameter left blank, a system-assigned
default, an action nobody chose — and, the detail that matters most
here, no notification, because the system did not classify it as a
customer decision. An unattended job that acts on a default and does
not report is the failure mode in both directions.

## The report line, and why it is not politeness

The fix I like least writing about, because it sounds obvious, is a
report of what the job *chose not to do*.

The argument for it is stronger than "it would be nice to know". An
unattended job's report is the only place its policy is observable. If
it only reports what it did, then "nothing happened to folder X" is
indistinguishable between four different worlds: X was skipped by
policy, X was never seen because of a glob edge case, X was seen and
the action failed silently, or X does not exist any more.

All four look the same. All four look like silence.

A line of the form *"would have created `X` — skipped, no opt-in"* does
three things a log of actions cannot. It makes the policy falsifiable
daily: if it names a folder you did not expect, the glob is wrong; if
it stops naming one, something changed. It converts an omission into an
event with a timestamp, which is the only kind of thing you can alert
on. And it is a dry run that never expires — `terraform plan`, `rsync
--dry-run`, `git clean -n` are all the same idea, run once by a human
before an action; a standing report line is that idea run every day by
the machine, for the actions it deliberately did not take.

## What is still not fixed

I would rather end here than on a victory lap.

**The report line has never fired.** It is implemented and it has not
yet had an occasion to print anything, which means it is untested.

**The skip list fails open.** The guard is otherwise well built — the
match is `grep -qxF`, exact and literal, so `mongo` does not match
`mongo-pi` — and it runs before anything writes. But it begins:

```bash
[ -f "$SKIP_FILE" ] || return 1
```

Delete or rename that file and every project silently becomes eligible
again. A guard file should fail closed, or at the very least shout.

**And the token's mtime still says it was never rotated.**

The script no longer has a create path. But it is still the same
script, on the same schedule, working from the same glob, and I am
still the person who will put a directory in `~/Projects` one evening
without thinking about what happens to it at eight the next morning.

---

*Verified on this box: Raspberry Pi 5, Debian 13, `gh 2.95.0`. Log
files, reflog entries, file modes and creation timestamps were read
2026-09-05 and re-checked 2026-09-06. Repository names are limited to
the four the argument needs; account-wide counts are deliberately
omitted. No token, or any part of one, appears in this post.*
