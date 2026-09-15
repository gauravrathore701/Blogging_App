---
title: "I cleaned my GitHub token out of my repos. A cron job quietly put it back."
description: "A daily sync script copied my GitHub token into git config files anyone on the machine could read, and logged nothing. I'd already cleaned it up once. How it happened, and the fix."
date: 2026-09-14
category: tech
tags: ["automation", "security", "cron", "git", "self-hosting"]
draft: false
---

A script runs on my Raspberry Pi every morning at 08:00 and backs up my projects to GitHub. When it found a project that wasn't connected to GitHub yet, it connected it for me. To do that, it built a GitHub address with my **personal access token** (basically a password for my GitHub account) pasted right into it, and saved that address in the project's `.git/config` file.

My token file is locked so only I can read it. The `.git/config` files are readable by every user on the machine. The script didn't log a single line about any of this. And the worst part: I had already found and cleaned this same token out of seven projects two months earlier. The script simply put it back into two new ones.

Here's the evidence, three files side by side:

```
$ stat -c '%A %n' ~/.github_token \
    ~/Projects/bloging-app/.git/config \
    ~/Projects/mongo-pi/.git/config
-rw------- .../.github_token
-rw-r--r-- .../bloging-app/.git/config
-rw-rw-r-- .../mongo-pi/.git/config
```

If you don't read Linux permissions: `rw-------` means only I can read the file. `rw-r--r--` and `rw-rw-r--` mean anyone on the machine can. The first file is the token, locked down on purpose. The other two are where the script copied it.

## What I thought was going on (I was wrong)

I didn't go looking for a token problem. I went looking for a different one.

I believed this script had been creating GitHub repositories on its own. I remembered repos showing up that I didn't remember making, and the script clearly contained `gh api user/repos`, the command that creates one. That was enough to convince me.

The logs proved me wrong almost immediately.

The job runs from cron, Linux's built-in scheduler:

```
0 8 * * * /home/gaurav/routines/git_sync.sh \
  >> .../logs/git_sync_cron.log 2>&1
```

Its first scheduled run was on **2026-06-21**:

```
[08:00:01] ===== Git Sync Start
           2026-06-21 08:00 =====
```

Every repo I was suspicious of was created on **2026-06-20**, the day before. All six were made between 11:45:43 and 11:47:32, in a single run of the script that lasted under two minutes. GitHub's creation times line up with the script's log, in order, a few seconds apart.

That run was me. I started it by hand, 16 minutes after installing GitHub's command-line tool on the Pi.

The scheduled job did try to create a repo later, twice. Both attempts **failed**, and neither repo exists on GitHub.

So the number of repos created by the job while I wasn't around is zero. I'd believed a false story about my own machine for two months, and I nearly published it.

## How the script decided what to touch

The better question turned out to be: *which projects does this script work on?*

The answer was "all of them". There was no list. It just looped over every folder in my projects directory:

```bash
for dir in "$PROJECTS_DIR"/*/; do
  name=$(basename "$dir")
```

So whatever folders existed at 08:00 got processed, with nobody watching. The folder's name was also used, unchanged, as the name of the GitHub repo.

Here's what it did with a folder that wasn't a git project yet:

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

In plain terms: turn the folder into a git project, commit everything (with a commit message written by an AI), create a private GitHub repo, connect the folder to it, and push. There was no confirmation step. A folder that had existed for a few hours was enough to trigger all of it.

Look at the end of the `gh api` line, too. `|| true` means "ignore it if this fails", and the error text is filtered and thrown away. Any error from GitHub that would have explained what was going on got silently discarded, every morning, for months.

The `https_url` on the last line is the bit that mattered. It built an address like `https://<token>@github.com/<user>/<name>.git`, with the token in the middle.

## New folders got processed the very next morning

The same thing happened to three folders, on three different mornings:

```
folder        created       processed
api-nexus     06-22 16:18   06-23 08:00
mongo-pi      07-15 15:10   07-16 08:00
bloging-app   09-02 00:49   09-02 08:00
```

I'd make a folder in the afternoon or late at night. By the next morning it had git history, a new branch, and an attempt to put it on GitHub.

One near miss scared me. On 2026-09-02 I created a folder called `pi-infra` at **08:13:31**, fourteen minutes after that morning's run had finished. It holds configuration for the services on this Pi. It went onto a "don't touch" list at 08:20:01, and I removed the repo-creation code from the script a few minutes after that.

Without those changes, the next morning's run would have found a folder full of infrastructure config and tried to put it on GitHub. I only caught it because I happened to be reading the script that morning for another reason.

## The moment the token got copied

For `bloging-app` (this blog's folder), three separate records agree on the exact second.

Git's own history of branch changes:

```
b832a39 develop@{2026-09-02 08:00:01 +0530}:
  branch: Created from HEAD
```

The config file's last-modified time:

```
2026-09-02 08:00:01.700300818
  .../bloging-app/.git/config
```

And the script's log for that day, which is everything it recorded about the folder:

```
[08:00:01] --- bloging-app ---
[08:00:01] bloging-app: creating develop
           from master
[08:00:02] bloging-app: ERROR — push failed
```

Notice what's missing. Nothing says a GitHub address was added, let alone one with a token in it. That part of the script had no log line at all. The only reason I can date it is the file's timestamp.

The push failed because the GitHub repo didn't exist. So nothing was uploaded. But the token had already been written into the config file.

## I'd already cleaned this up once

This is why I wrote the post.

On **2026-06-29**, I found this same token inside the `.git/config` files of seven other projects on the Pi. I switched all seven to SSH, a way of connecting to GitHub that uses a key file instead of a token in the address. That cleanup held: all seven still use SSH today.

My note from that day also said the token should be revoked and replaced.

Sixty-five days later, the script put the same token back, into a folder that didn't even exist in June.

I never changed the script in between. I cleaned up the **mess** and left the **thing that made the mess** running, and it didn't care what I'd cleaned up. That's the lesson, and it applies far beyond this one script:

**A cleanup fixes things once. A scheduled job runs every day. If they disagree, the scheduled job wins.**

## Why I didn't notice

Four reasons, and all four apply to other scheduled jobs:

- **The dangerous code rarely ran.** The part that added a GitHub address ran on three folders in the first 83 runs. The other runs did boring, correct things.
- **The dangerous code was the silent code.** Almost everything else the script did went into the log. This part didn't.
- **The error I could see pointed somewhere else.** Every morning the log said `ERROR — push failed`, which looks like a network or permissions problem. It was red, it was obvious, and it sent me looking in the wrong place for weeks. The token being copied produced no line at all.
- **The safety check I did have worked perfectly.** Before its first commit, the script adds `.env`, `*.key`, `*.pem` and similar files to `.gitignore`, so secrets don't get committed. It worked: `mongo-pi/.env`, which holds database passwords, never made it into a commit. I'd thought hard about secrets **leaving** a project. The secret that moved that morning came **into** one. And when a safety check visibly works, you stop looking.

## Two ideas that changed how I write these jobs

**Doing everything isn't the same as doing anything.** There are three ways a job can decide what to work on:

- **An allow list:** only what's listed. You have to remember to add each new project.
- **A block list:** everything except what's listed. You have to predict which future projects to exclude.
- **Everything:** a block list with nothing on it, which is what I had.

The catch is that this job's whole purpose is to back up things I forgot to set up. An allow list would defeat that. The answer is to split "look at everything" from "do something permanent to everything". The job can still find every folder and make a local backup commit, which is harmless. It just can't create things on GitHub or push to them on its own.

**"Create it if it's missing" is riskier than it sounds.** `mkdir -p` creates a folder if it's missing, and that's fine. Creating a GitHub repo if it's missing is different, for three reasons:

- **It happens on someone else's system**, under your account, not on your own disk.
- **The name comes from whatever folder happens to exist**, including something unpacked, copied or created by a tool.
- **It's easy to do and hard to undo.** Creating takes one command. Undoing means working out whether anything already leaked.

Big companies hit the same shape. In 2024, Google Cloud [deleted a pension fund's entire private cloud](https://cloud.google.com/blog/products/infrastructure/details-of-google-cloud-gcve-incident) after a setting was left blank and a default kicked in. Google's write-up says no warning was sent, because the deletion wasn't triggered by a customer request. A job that acts on a default and doesn't tell anyone is the same problem, whichever way it points.

## The fix

These are the changes I made to the script, and each one is live now:

1. **It no longer creates GitHub repos, ever** (2026-09-02). Both places that called `gh api user/repos` are gone. A new folder gets a local git commit on the Pi and nothing else. A project with no GitHub connection is reported and skipped.
2. **It reports what it chose not to do.** The daily summary it sends me now has lines like "committed locally, no GitHub repo" and "not in config, not pushed". Silence used to look the same whether a folder was skipped, missed or broken. Now every skipped folder is named.
3. **It doesn't use the token at all anymore** (2026-09-05). It pushes each project through the GitHub connection that project already has. The code that built token addresses is gone, and the script no longer even reads the token file.
4. **Pushing is now allow-list only** (2026-09-05). A project is pushed only if it's listed in a config file, its GitHub address matches the listed one, and it's on an allowed branch. Anything else is reported, not pushed.
5. **The "don't touch" list fails safe** (2026-09-05). If that list file ever goes missing, the script skips every project and logs a warning. The old version did the opposite and treated every project as fair game.
6. **The token is out of the config files** (2026-09-05). I switched both affected projects to SSH. A scan of every `.git/config` under my projects folder finds no token in any of them.

**Proof it works.** This morning, 2026-09-14, the script found a brand-new folder I'd created the day before. Here's what it did (folder name and commit message trimmed):

```
[08:01:37] <new-folder>: not a git repo
           — initializing
[08:01:46] <new-folder>: initial commit
           (local only) — ...
[08:01:46] <new-folder>: no remote
           — not created, not pushed
```

It made a local backup and reported the folder. It didn't create a repo, add an address, or copy a token.

## The last step: kill the token

Cleaning the token out of files doesn't make it safe. A copy anyone could have read is still a working password until GitHub stops accepting it. So on 2026-09-14 I deleted it on GitHub.

Before deleting it, I made sure nothing still needed it. The sync script had stopped reading the token on 2026-09-05, GitHub's command-line tool wasn't logged in with it, and no other script or service on the Pi used it. Deleting it couldn't break anything.

Then I tested whether it was really dead, by sending GitHub a request with the old token. That test caught a mistake straight away:

```
18:47  GET /user  →  200  (still accepted)
18:50  GET /user  →  401  (refused)
```

My first attempt deleted the **wrong token**. GitHub still accepted the old one. Deleting a token takes effect immediately, so a 200 meant this one was still alive. It was a fine-grained token with no expiry date, and I found and deleted it on the second try. Three minutes later, GitHub refused it.

If I had trusted "I clicked delete", this post would have announced a dead token that still worked.

### I also locked the Pi out of GitHub

While cleaning up, I accidentally deleted the Pi's **SSH key** on GitHub too. After the fix, SSH is the only way the sync script pushes, so the next 08:00 run would have failed to push anything. The Pi could no longer log in:

```
$ ssh -T git@github.com
git@github.com: Permission denied (publickey).
```

The private key was still safe on the Pi, so all I had to do was add its public half back on GitHub. Then I tested again:

```
$ ssh -T git@github.com
Hi gauravrathore701! You've successfully
authenticated, but GitHub does not provide
shell access.
```

To check that git itself worked, not just the login, I listed the blog's branches on GitHub from the Pi, and got `main` back.

That's the same lesson as the rest of this post, pointed the other way. A cleanup is a change like any other, and it can break things quietly. Test after you clean up, not just after you build.

## Where it stands now

- **The token is dead.** GitHub refuses it, so any copy, wherever it ended up, is useless.
- **The script can't bring it back.** It no longer reads a token, creates repos, or writes GitHub addresses into config files.
- **Pushes go over SSH**, and I tested that connection after the cleanup, not just before.
- **New folders get a local backup commit and a line in the daily report.** Nothing goes to GitHub without me.

The exposure was real but contained. The token sat in a file anyone on the Pi could read: in `mongo-pi` from 2026-07-16 to 2026-09-05, and in `bloging-app` from 2026-09-02 to 2026-09-05. This is a single-user machine, and nothing served those folders to the internet.

---

*Checked on this Pi: Raspberry Pi 5, Debian 13, `gh 2.95.0`. Logs, git history, file permissions and creation times were read 2026-09-05 and 2026-09-06. The fix and this morning's log were checked 2026-09-14, and so were the token deletion (18:47–18:50) and the SSH key being restored (18:51). Only the folders the story needs are named. No token, or any part of one, appears in this post.*
