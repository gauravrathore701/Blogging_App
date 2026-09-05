---
title: "Discord's mandatory E2EE made my voice bot deaf, and there is no opt-out"
description: "DAVE encryption broke voice receive in every bot library. Why sending still works, why close code 4017 makes opting out impossible, and the decrypt bridge that fixed it."
date: 2026-09-03
category: tech
tags: ["discord", "python", "e2ee", "debugging"]
draft: true
---

The first fix was to uninstall the encryption library. That broke joining
a voice channel entirely.

The second fix was to keep it installed and lie about the version. That
worked in offline tests, and then Discord closed the connection with code
**4017** and the bot began flapping in and out of the channel every few
seconds.

There is no opt-out. You have to decrypt it yourself.

## Verified against

This is one working fix, on one pinned set of versions, using six symbols
— four of them private. If your versions differ, treat what follows as a
map, not a patch.

```
davey                  0.1.6
discord-ext-voice_recv 0.5.2a179
discord.py             2.7.1
PyNaCl                 1.5.0
```

Status, 2026-09-03: the bridge below has been loading in production since
July and has logged zero decrypt failures in the journal I still have.
See the honesty section at the end for exactly what that does and does
not prove.

## The symptom

A bot that joins voice fine, shows as connected, and hears nothing. In
Python you get this, once, from voice-recv's packet router thread:

```
discord.opus.OpusError: corrupted stream
```

On the JavaScript side the same root cause surfaces differently —
`DecryptionFailed`, or reconnect loops with zero audio captured. The two
communities have not connected their issue threads to each other, because
the errors do not look alike.

The important part is the word *once*. The router thread dies on that
exception and is not restarted. Zero packets arrive for the rest of the
session, with no further errors and no indication that anything is wrong.
Every confusing secondary symptom follows from this: a short burst of
"speech" that is decrypt garbage, a second join that receives nothing, a
bot that was fine yesterday.

Before any of that is visible you may have to turn logging on at all.
`client.start()`, unlike `client.run()`, configures no logging, so every
warning from discord.py and voice-recv is swallowed:

```python
logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("discord.ext.voice_recv").setLevel(logging.DEBUG)
```

That was the actual first fix: making the failure visible.

## The line that cracks it

With logging on, the voice session description contains:

```
dave_protocol_version: 1
```

DAVE is Discord's end-to-end encryption for audio and video — MLS-based
(RFC 9420), with per-sender media keys. Discord announced it in September
2024, and in their [May 2026 post](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted)
they wrote: *"At the beginning of March 2026, we completed that
migration."* Stage channels are the stated exception. Everything else is
E2EE, and that includes your bot.

That blog post also says DAVE was extended to support bots and apps. That
is true — for **sending**. Receiving is the gap.

## Why receive dies and send does not

Discord voice has always had transport encryption between your client and
Discord's servers. DAVE adds a second, inner layer between *participants*
that Discord's own servers cannot read.

So the chain for a received frame is now:

1. The frame arrives, encrypted at the transport layer.
2. voice-recv decrypts the transport layer. **This succeeds.** It has
   the key; nothing has changed here.
3. What comes out is still DAVE-encrypted Opus.
4. voice-recv, which has no idea DAVE exists, hands it to the Opus
   decoder.
5. Opus sees ciphertext, raises `corrupted stream`, and the router thread
   dies.

The transport decryption working perfectly is exactly what makes this
hard to diagnose. Nothing reports a decryption failure, because no
decryption failed.

Sending is unaffected because discord.py 2.7 does the DAVE encryption
itself on the way out, through `davey` — a Rust implementation of the
protocol with Python bindings, by Snazzah. The library that receives is a
separate project that has not shipped since **2025-06-18**, roughly eight
and a half months before the mandate that broke it. Its README does not
mention DAVE or E2EE anywhere.

## Why you cannot just turn it off

Two attempts, in the order I made them, sixteen minutes apart.

**Uninstall `davey`.** discord.py then advertises DAVE protocol version 0
— no encryption — which is exactly what you want. It also refuses to
build a `VoiceClient` at all:

```
RuntimeError: davey library needed in order to use voice
```

That is a hard requirement in `discord/voice_client.py`. If you searched
that string and landed here: this is what it means. Reinstall `davey`.

**Keep `davey`, lie about the version.** The advertised version is read
from one property, used in one place — the voice IDENTIFY payload:

```python
discord.voice_state.VoiceConnectionState.max_dave_protocol_version = property(lambda self: 0)
```

This negotiates DAVE v0 successfully in an offline test. Live, the voice
gateway rejects the handshake with close code **4017**, discord.py
retries forever, and the bot flaps in and out of the channel. 4017 is not
in the 4000–4016 close-code table most tutorials copy from, which is why
searching for it turns up almost nothing.

Both attempts fail for the same reason: since March 2026 a non-stage
voice connection that does not do DAVE is not a connection Discord will
accept.

## The bridge

The seam is the last place a received frame is still bytes, before the
Opus decoder gets it. Patch there, decrypt with the session discord.py
already built for sending, and substitute Opus silence on any failure so
the router thread cannot die:

```python
_orig_decode_packet = _vr_opus.PacketDecoder._decode_packet
_dave_fail_count = 0


def _dave_decode_packet(self, packet):
    global _dave_fail_count
    if packet and len(packet.decrypted_data or b"") > 3:
        vc = self.sink.voice_client
        state = vc._connection
        if state.dave_session is not None and state.dave_protocol_version > 0:
            user_id = self._cached_id or vc._get_id_from_ssrc(self.ssrc)
            try:
                if not user_id:
                    raise LookupError(f"no user mapped to ssrc {self.ssrc}")
                packet.decrypted_data = state.dave_session.decrypt(
                    int(user_id), davey.MediaType.audio, packet.decrypted_data
                )
            except Exception as e:
                packet.decrypted_data = _OPUS_SILENCE
                _dave_fail_count += 1
                if _dave_fail_count % 50 == 1:
                    print(f"[voice] DAVE decrypt failed (#{_dave_fail_count}, user={user_id}): {e!r}", flush=True)
    return _orig_decode_packet(self, packet)


_vr_opus.PacketDecoder._decode_packet = _dave_decode_packet
```

`_OPUS_SILENCE` and `_vr_opus` come from voice-recv:

```python
from discord.ext.voice_recv import opus as _vr_opus
from discord.ext.voice_recv.rtp import OPUS_SILENCE as _OPUS_SILENCE
```

The silence substitution is not cosmetic. Without it, one bad frame kills
the thread and the bot is deaf until restart. With it, a bad frame costs
20 ms of audio.

Note that DAVE decryption is **per sender**, which is why the SSRC → user
ID lookup is in there. The signature is not guessed; it is in the shipped
type stub:

```python
def decrypt(self, user_id: int, media_type: MediaType, packet: bytes) -> bytes:
```

## The six symbols, and which ones will betray you

| Symbol | Owner | Private? |
|---|---|---|
| `voice_recv.opus.PacketDecoder._decode_packet` | voice-recv | yes |
| `packet.decrypted_data` | voice-recv | no |
| `voice_client._connection.dave_session` | discord.py | yes |
| `voice_client._connection.dave_protocol_version` | discord.py | yes |
| `voice_client._get_id_from_ssrc(ssrc)` | discord.py | yes |
| `voice_recv.rtp.OPUS_SILENCE` | voice-recv | no |

Four of six are private. `davey` is 0.1.x and classified Beta; it went
0.1.4 → 0.1.6 in under four months. Any discord.py 2.8 could rename
`_connection.dave_session`. voice-recv's own README warns that no
guarantees are given for stability.

**Three checks to tell if this has gone stale**, in order:

1. Does `PacketDecoder._decode_packet` still exist?
2. Does `voice_client._connection.dave_session` still exist?
3. Does `davey`'s `decrypt()` still take `(user_id, media_type, packet)`?

If any answer is no, stop reading this post and read the source.

## What this is not

It is not upstream support, and I am not going to pretend otherwise.

The durable part is not the twenty lines of patch. It is the causal
chain — mandatory DAVE, transport decrypt succeeds, ciphertext reaches
Opus, thread dies, permanent silence — and the fact that 4017 makes
opting out impossible. That stays true after the patch stops applying,
including for whoever reviews the real fix when it lands.

There are at least five open threads on this across three projects
([discord.js #11419](https://github.com/discordjs/discord.js/issues/11419),
openclaw [#24825](https://github.com/openclaw/openclaw/issues/24825) and
[#24883](https://github.com/openclaw/openclaw/issues/24883),
[voice-recv #27](https://github.com/imayhaveborkedit/discord-ext-voice-recv/issues/27),
and an Answer Overflow thread), none resolved. voice-recv #27 — "bot
suddenly stops listening" — was closed with no fix, and reads exactly
like this bug filed before anyone knew what DAVE was.

**Honest limits on my own evidence.** The bridge loads cleanly in
production; I can grep the journal for the line that says so. But my
journal only retains back to 2026-08-30, the bot has been idle since, and
so the last time I *watched* audio come through this patch was
2026-07-07. Zero logged decrypt failures means zero in the retained
window, not zero ever. If you are about to depend on this, run it and
watch your own logs rather than trusting mine.
