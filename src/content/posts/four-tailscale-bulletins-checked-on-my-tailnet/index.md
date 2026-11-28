---
title: "Four Tailscale bulletins, and the SSH policy that worried me more"
description: "Tailscale published four SSH and Serve bulletins on 26 October. My Pi and VM are patched now, but the Pi took 15 days to get there, and the check turned up an SSH policy far wider than anything I use."
date: 2026-11-27
category: tech
tags: ["tailscale", "security", "ssh", "raspberry-pi", "self-hosting"]
draft: true
---

On 26 October Tailscale published four security bulletins at once: two for Tailscale SSH and two for Tailscale Serve. My Raspberry Pi and the Oracle VM that acts as its [failover twin](/blog/posts/pi-failover-twin-part-1-a-standby-that-does-nothing/) both talk to each other over Tailscale SSH, so "am I affected?" was a real question.

The short answer: both are patched today. But the Pi sat on a vulnerable version for 15 days after the bulletins came out, and checking whether that mattered turned up something worse than the bugs: an SSH policy that allows far more than I ever use.

Everything below is read-only. Five checks, run on 27 November.

## Four bulletins, one fixed version

All four are fixed in 1.104.4, released on 28 October. None of them gives a severity score or an affected version range, only the fixed version. What matters is the precondition each one needs, so here they are, mostly in Tailscale's words:

- **TS-2026-014**: "Tailscale SSH Unix socket forwarding could grant peers access to root-only sockets." It "affects users with Tailscale SSH enabled who also allow local or remote forwarding in their access policies."
- **TS-2026-015**: "Memory exhaustion in Tailscale SSH session handling could lead to denial of service." It "affects nodes running the Tailscale SSH server", and "an authenticated SSH session permitted by policy is required to trigger the condition."
- **TS-2026-016**: "`tailscale serve` Unix backends could reach privileged sockets, including the `tailscaled` local API socket." It needs someone local who can write a serve config, or write to a backend path, and the bulletin says it "allowed full node takeover".
- **TS-2026-017**: "HTTP/2 shared serve context could send the wrong `Tailscale-App-Capabilities` values across mounts." It needs serve with TLS and "at least two mounts with different capability requirements on the same node."

So two questions decide everything: do I run Serve, and do I run Tailscale SSH with forwarding allowed?

## Check 1: both nodes are on a fixed version

```
$ tailscale version | head -1
1.104.5
```

Same answer on the VM. 1.104.5 is newer than 1.104.4, so all four fixes are in. (The latest is 1.104.7; the changelog lists no SSH or Serve security fix after 1.104.4, so that gap isn't urgent for these four.)

## Check 2: the Pi got there late

"Patched now" doesn't tell you how long you weren't. apt keeps a history:

```
$ zgrep -h -A2 '^Start-Date' /var/log/apt/history.log* \
    | grep -B1 -A1 'tailscale='
Start-Date: 2026-11-10  05:51:23
Commandline: apt-get install --yes --allow-downgrades tailscale=1.104.5
Upgrade: tailscale:arm64 (1.104.2, 1.104.5)
--
Start-Date: 2026-10-25  18:11:15
Commandline: apt-get install --yes --allow-downgrades tailscale=1.104.2
Upgrade: tailscale:arm64 (1.102.2, 1.104.2)
```

(Newest first: the current log, then the rotated `.1.gz`.)

The Pi moved to 1.104.2 the day before the bulletins and stayed there until 10 November at 05:51. That's 15 days after the bulletins, and 13 days after 1.104.4 was out. It skipped 1.104.4 entirely.

I never ran either of those commands myself. Both look like Tailscale's own auto-updater, which is switched on:

```
$ tailscale debug prefs | grep -A2 AutoUpdate
	"AutoUpdate": {
		"Check": true,
		"Apply": true
```

That part is my inference from the setting and the pinned `tailscale=VERSION` command shape. The Pi's journal from 10 November has already rotated out, so I can't show the updater logging it, and I don't know why it waited 13 days.

The VM had no such gap. Its apt history shows Tailscale was first installed on 5 November, straight at 1.104.5.

The lesson I take from this: auto-update on means "eventually", not "the day the bulletin lands". If a bulletin matters to you, check the version yourself.

## Check 3: I don't run Serve

```
$ tailscale serve status
No serve config
$ tailscale funnel status
No serve config
```

Same on the VM. TS-2026-016 and TS-2026-017 both need Serve, so neither applied to me, even during those 15 days.

## Check 4: I do run Tailscale SSH

```
$ tailscale debug prefs | grep '"RunSSH"'
	"RunSSH": true,
```

`true` on both nodes, and it's not decoration. The `ssh peer` alias my failover scripts use goes over it. The VM's `tailscaled` log shows five SSH sessions between 09:00 and 10:00 today, each granted with a line like this one (my login trimmed out):

```
ssh-session(sess-…): access granted
  to <me> as ssh-user "gaurav"
```

So TS-2026-014 and TS-2026-015 were in scope. Whether 014 actually applied depends on the policy.

## Check 5: my policy allows forwarding, and root

The SSH rules from the tailnet policy are pushed to every node, so you can read them locally without opening the admin console. The netmap needs root:

```
$ sudo tailscale debug netmap | python3 -c '
import json,sys
r = json.load(sys.stdin)["SSHPolicy"]["rules"]
print(len(r), r[0]["action"])
print(r[0]["sshUsers"].get("root"))'
1 {'accept': True, 'allowAgentForwarding': True,
   'allowLocalPortForwarding': True,
   'allowRemotePortForwarding': True}
root
```

(Wrapped to fit.) One rule, and it allows local forwarding, remote forwarding, agent forwarding, and logging in as root. Its principals are eight node addresses, which I read as IPv4 and IPv6 for the four devices on my tailnet.

So yes: for those 15 days the Pi met TS-2026-014's precondition exactly. Tailscale SSH was on, and the policy allowed forwarding.

Then I checked what I actually use. Neither machine's `~/.ssh/config` has a `LocalForward`, `RemoteForward`, `DynamicForward` or `ForwardAgent` line, and none of my failover scripts pass `-L`, `-R` or `-D`. All five sessions in that hour logged in as `gaurav`, not root.

My reasoning from here (no test behind it): TS-2026-014 let a peer reach root-only sockets. But the only peers this rule allows are my own devices, and the same rule already lets them log in as root, which reaches everything. The bug added nothing a peer didn't already have.

That's not reassuring. It means the real exposure was never the bug. It's a policy that hands root, plus three kinds of forwarding I never use, to what looks like every device on the tailnet. If any one of them is compromised, it doesn't need a Tailscale bug to own the Pi.

## Root and forwarding should go

I haven't changed anything yet. These are the options, smallest first:

- **Drop root and forwarding from the SSH rule.** Nothing I run needs them.
- **Or turn forwarding off on the node.** TS-2026-014's own mitigation is `TS_SSH_DISABLE_FORWARDING=1` in the `tailscaled` service environment, then a restart. That keeps Tailscale SSH working.
- **Check the other two devices.** Both were offline when I wrote this, so I haven't seen their versions.

## Five commands for any tailnet

For any Tailscale bulletin, on every node:

1. `tailscale version`: are you at or past the fixed version?
2. `/var/log/apt/history.log` (or your package log): since when?
3. `tailscale serve status`: does Serve apply to you at all?
4. `tailscale debug prefs | grep RunSSH`: does Tailscale SSH?
5. `sudo tailscale debug netmap`, then the `SSHPolicy` rules: what does your policy actually allow?

The fifth check is the one I'd never run before, and it was the only one that found something.
