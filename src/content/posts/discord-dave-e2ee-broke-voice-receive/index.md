---
title: "Discord's mandatory E2EE made my voice bot deaf, and there is no opt-out"
description: "Discord's new voice encryption left my bot able to talk but not listen. Why that happens, why you can't switch it off, and the small patch that got it hearing again."
date: 2026-09-03
category: tech
tags: ["discord", "python", "e2ee", "debugging"]
draft: false
---

My first fix was to uninstall the encryption library. After that, the bot couldn't join a voice channel at all.

My second fix was to keep the library but tell Discord my bot didn't support encryption. That passed my offline test. Then Discord refused the connection with code **4017**, and the bot started jumping in and out of the voice channel over and over.

It turns out you can't opt out. If your bot wants to hear people, it has to decrypt the audio itself.

## The versions this was tested on

This is one fix that worked for me, on one exact set of library versions. It relies on six pieces of other people's code, and four of those are private internals that could change without warning. If your versions are different, use this post as a map, not a copy-paste patch.

```
davey                  0.1.6
discord-ext-voice_recv 0.5.2a179
discord.py             2.7.1
PyNaCl                 1.5.0
```

Status on 2026-09-14: I tested it live today, with exactly these versions. The bot heard a full sentence and transcribed it correctly. It also hit a burst of decryption failures in the first moment of speech, and the patch absorbed them. The last section has the details.

## What went wrong

My bot joined voice without any trouble. Discord showed it as connected. It could play audio, too: its greeting came through fine. But it heard nothing.

The bot's own log even showed Discord's "started speaking" event when I talked, so my microphone and push-to-talk were fine. The audio was reaching the bot. The bot just wasn't getting anything out of it.

In Python, the only clue was this error, printed **once**:

```
discord.opus.OpusError: corrupted stream
```

Some background on the pieces involved:

- **Opus** is the audio format Discord uses for voice.
- **discord.py** is the main Python library for Discord bots. It can send audio, but it can't receive it.
- **voice-recv** (`discord-ext-voice-recv`) is a separate add-on that gives discord.py the ability to listen.

Inside voice-recv, one background worker (a "thread") takes incoming audio packets and passes them to the Opus decoder. When the decoder raised that error, the worker crashed. Nothing restarted it.

That's why "once" matters so much. After that crash, no audio arrives for the rest of the session. There are no more errors and no warnings. The bot just sits there, deaf.

It also explained the weird things I'd seen earlier. According to my notes from that night, one test picked up about a quarter of a second of "speech" and then nothing, which was garbage audio arriving just before the worker died. When I joined again, the bot heard nothing at all.

If you use JavaScript instead, the same problem looks different. People see `DecryptionFailed` errors, or bots that keep reconnecting and never capture audio. The errors don't look alike, so it's easy to miss that the Python and JavaScript bug reports are about the same thing.

## Step zero: make the errors visible

Before any of that, I couldn't even see the error.

My bot starts with `client.start()` instead of `client.run()`. The difference I hadn't noticed is that `client.run()` sets up logging for you and `client.start()` doesn't. So every warning from discord.py and voice-recv was being silently thrown away.

Three lines fixed that:

```python
logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("discord.ext.voice_recv").setLevel(logging.DEBUG)
```

Honestly, this was the real first fix. You can't debug a failure you can't see.

## The log line that explained it

With logging on, the details Discord sent back when the bot connected included this:

```
dave_protocol_version: 1
```

**DAVE** is Discord's end-to-end encryption (E2EE) for voice and video. "End-to-end" means the audio is locked so that only the people in the call can unlock it. Not even Discord's own servers can listen in. Each person in the call has their own key, so each speaker's audio has to be unlocked separately. (Under the hood it's built on a standard called MLS, RFC 9420.)

Discord announced DAVE in September 2024. In a [May 2026 blog post](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted), they wrote: *"At the beginning of March 2026, we completed that migration."* Stage channels are the one exception. Every other voice call is now encrypted this way, and that includes calls with your bot in them.

The same post says DAVE was extended to support bots and apps. That's true, but only for **sending** audio. Receiving is where it falls apart.

## Why the bot could talk but not listen

Discord voice has always been encrypted between your app and Discord's servers. Think of it as an outer envelope. DAVE adds a second, inner envelope that only the people in the call can open.

Here's what now happens to each piece of audio the bot receives:

1. The audio arrives inside both envelopes.
2. voice-recv opens the outer envelope. **This works fine.** It has the key for that, and nothing about it changed.
3. Inside is another sealed envelope: audio still encrypted with DAVE.
4. voice-recv has never heard of DAVE. It assumes the outer envelope was the only one and passes the still-encrypted data to the Opus decoder.
5. The decoder sees scrambled data, raises `corrupted stream`, and the worker thread crashes.

The frustrating part is that step 2 works perfectly. Nothing ever reports "decryption failed", because the decryption it knows about didn't fail. It just wasn't the only one anymore.

Sending still works because discord.py 2.7 adds the DAVE encryption itself before audio goes out. It does that with a library called `davey`, which is Snazzah's Rust implementation of DAVE with a Python wrapper.

Receiving is voice-recv's job, and voice-recv hasn't released a new version since **2025-06-18**. That's about eight and a half months before Discord made encryption mandatory. Its README doesn't mention DAVE or E2EE anywhere.

## Why you can't just switch it off

I tried two ways of avoiding the encryption. The second came seven minutes after the first.

**Attempt 1: uninstall `davey`.** Without it, discord.py tells Discord the bot doesn't support DAVE, which sounds like exactly what I wanted. But discord.py also refuses to start voice at all:

```
RuntimeError: davey library needed in order to use voice
```

discord.py 2.7.1 simply won't create a voice connection without `davey` installed. If you searched for that error and ended up here, that's what it means. Put `davey` back.

**Attempt 2: keep `davey`, but lie about support.** The DAVE version the bot offers comes from a single setting, and it's only used in one place: the "hello" message the bot sends when it connects to voice. So I overrode that setting to say "version 0", meaning no DAVE:

```python
discord.voice_state.VoiceConnectionState.max_dave_protocol_version = property(lambda self: 0)
```

In an offline test, this worked. The bot offered version 0.

On the real Discord servers, it didn't. Discord rejected the connection with close code **4017**. discord.py kept retrying forever, so the bot kept joining and leaving the channel.

Discord's developer docs describe 4017 as *"E2EE/DAVE protocol required"*: *"This channel requires a client supporting E2EE via the DAVE Protocol."* Many older guides list close codes only up to 4016, so they don't mention it.

Both attempts failed for the same reason. Since March 2026, Discord won't accept a voice connection that doesn't use DAVE, except in stage channels.

That whole detour took sixteen minutes, from turning logging on to writing the fix below.

## The fix: decrypt the audio yourself

If voice-recv won't open the inner envelope, the bot has to open it before the audio reaches the decoder.

Luckily, discord.py already has everything needed. To send encrypted audio, it keeps a live DAVE session with all the keys for the call. That same session can decrypt, too. Nobody had connected it to the receiving side.

So I "monkeypatched" voice-recv, which means replacing one of its functions with my own version while the bot is running. I didn't edit the library's files. My version runs just before audio goes to the Opus decoder, since that's the last point where the audio is still raw bytes.

It does three things:

- works out who sent the packet, since each speaker has their own key
- decrypts the packet using discord.py's DAVE session
- swaps in a short piece of silence if anything goes wrong, so the worker thread never crashes again

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

`_OPUS_SILENCE` and `_vr_opus` both come from voice-recv:

```python
from discord.ext.voice_recv import opus as _vr_opus
from discord.ext.voice_recv.rtp import OPUS_SILENCE as _OPUS_SILENCE
```

A few notes on how it works:

- **The silence isn't just cosmetic.** Without it, one bad packet crashes the worker and the bot stays deaf until it restarts. With it, a bad packet costs you 20 milliseconds of audio.
- **The size check skips tiny packets.** Packets of 3 bytes or less are skipped, so empty and silence packets pass straight through.
- **The failure log is throttled.** The patch prints the 1st failure, then the 51st, then the 101st, and so on, so a bad stretch can't flood the log.
- **The sender lookup uses the SSRC.** Every audio stream in a call has a number called an SSRC. Because DAVE uses a different key for each speaker, the patch has to turn that number into a Discord user ID before it can decrypt anything.

I didn't guess the `decrypt()` arguments. They're written in the type stub that ships with `davey`:

```python
def decrypt(self, user_id: int, media_type: MediaType, packet: bytes) -> bytes:
```

## Why this patch will break one day

The patch relies on six pieces of code from other libraries. In Python, a name starting with `_` means "private: for internal use, may change without notice". Four of these six are private:

| What it uses | From | Private? |
|---|---|---|
| `voice_recv.opus.PacketDecoder._decode_packet` | voice-recv | yes |
| `packet.decrypted_data` | voice-recv | no |
| `voice_client._connection.dave_session` | discord.py | yes |
| `voice_client._connection.dave_protocol_version` | discord.py | yes |
| `voice_client._get_id_from_ssrc(ssrc)` | discord.py | yes |
| `voice_recv.rtp.OPUS_SILENCE` | voice-recv | no |

The libraries underneath aren't settled either:

- **davey** is at version 0.1.x and marked Beta. It went from 0.1.4 to 0.1.6 in under four months.
- **discord.py** could rename `_connection.dave_session` in any future release, such as a 2.8.
- **voice-recv's** own README says no guarantees are given for stability.

**Three quick checks to see whether this post is out of date**, in this order:

1. Does `PacketDecoder._decode_packet` still exist?
2. Does `voice_client._connection.dave_session` still exist?
3. Does `davey`'s `decrypt()` still take `(user_id, media_type, packet)`?

If the answer to any of them is no, stop reading this and go read the library source.

## What this isn't

This isn't official support, and I won't pretend it is.

The patch is about twenty lines, and it will stop working eventually. The part that will stay useful is the explanation:

- Discord made DAVE mandatory.
- The outer decryption still works, so nothing reports a problem.
- Still-encrypted audio reaches the Opus decoder.
- The decoder errors, the worker thread crashes, and the bot is silently deaf.
- Close code 4017 means you can't opt out.

That stays true even after the patch breaks. It should also help whoever reviews the proper fix when it arrives.

I found at least five threads about this across three projects and one forum: [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419), openclaw [#24825](https://github.com/openclaw/openclaw/issues/24825) and [#24883](https://github.com/openclaw/openclaw/issues/24883), [voice-recv #27](https://github.com/imayhaveborkedit/discord-ext-voice-recv/issues/27), and an Answer Overflow thread. None of them has a fix. voice-recv #27, titled "bot suddenly stops listening", was closed without one. It reads exactly like this bug, reported before anyone knew DAVE was the cause.

## The live test

Before publishing, I joined a voice channel with the bot on 2026-09-14 and talked to it. Here's the log, trimmed:

```
15:25:49 joined 'General', listening
         dave_protocol_version: 1
15:26:31 speaking START
15:26:31 DAVE decrypt failed (#1) ...
         UnencryptedWhenPassthroughDisabled
15:26:31 DAVE decrypt failed (#51) ...
15:26:42 utterance captured: 1000ms voiced
15:26:52 transcribed: <my full sentence>
```

What that shows:

- **DAVE was on.** The connection used protocol version 1, so the audio really was end-to-end encrypted.
- **Receiving works.** The bot decrypted my speech, and the speech-to-text step got the sentence right.
- **Decryption does fail sometimes.** The patch logs every 50th failure, so seeing #1 and #51 means somewhere between 51 and 100 packets failed. All of it happened within about 50 milliseconds, right as I started talking. The error means `davey` got a packet that wasn't DAVE-encrypted while its "let unencrypted packets through" mode was off. The log doesn't show why those first packets arrived like that.
- **The silence swap earned its place.** Each of those failures became a short silence instead of a crashed worker thread. Without it, the bot would have gone deaf in the first second.

voice-recv also logged ten `CryptoError decoding packet data` lines, one at 15:26:53 and nine at 15:27:03. Those come from the outer encryption layer, before my patch runs, so the patch didn't cause them and doesn't handle them. voice-recv skipped those packets, and the bot kept receiving audio afterwards.

That's one test, on one day, with one speaker. If you're going to rely on this, run it yourself and watch your own logs instead of trusting mine.
