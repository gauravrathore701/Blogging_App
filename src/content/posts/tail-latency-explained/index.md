---
title: "Tail latency: why the slowest 1% of calls ends up slowing most of your requests"
description: "Why averages hide slow requests, how fan-out turns one slow server in a hundred into most users waiting, and how hedged requests cut the tail for about 5% extra load."
date: 2026-10-22
category: tech
tags: ["backend-concepts", "distributed-systems", "latency", "performance"]
draft: false
---

The [last Backend Concepts post](/blog/posts/bulkhead-pattern-explained/) was about stopping one slow dependency from taking everything down with it. This one is about the slowness itself: not the dependency that hangs for minutes, but the ordinary server that is fast almost every time and slow just once in a while. That "once in a while" has a name, tail latency, and at scale it turns out to matter more than the typical case. These are my notes on it.

## What the "tail" is

If you measure how long a thousand requests take and plot them, most bunch up around some typical value, and a few stretch far off to the right. Those few are the tail.

You describe it with percentiles. The p50 (median) is the time half of all requests beat. The p99 is the time 99% of requests beat, so 1 request in 100 is slower than it. The p99.9 is 1 in 1,000.

The average is the number people reach for first, and it's the least useful one here. I simulated a server on my Pi that answers in 5 to 15 ms, except that 1 call in 100 stalls for an extra second:

```
mean 20.1  p50 10.1  p99 1005.1  p99.9 1014.0 ms
```

The mean says 20 ms. No request actually took 20 ms: 99% took around 10, and 1% took over a second. The mean blends the two into a number that describes nobody. The p50 tells you what a typical request feels like, and the p99 tells you about the slow ones. You need both.

## Why 1 in 100 becomes most of your requests

One slow call in 100 sounds tolerable. The trouble starts when one user request needs answers from many servers at once.

Big services do this all the time. A search query is sent to hundreds of servers, each holding a slice of the index, and the page can't be built until the replies are in. Jeff Dean and Luiz André Barroso describe it in their 2013 paper *The Tail at Scale*: "These sub-operations must all complete within a strict deadline for the service to feel responsive."

A request that waits for 100 servers is as slow as the slowest of the 100. If each server is slow 1% of the time, the chance that all 100 are fast is 0.99 multiplied by itself 100 times, which is about 0.366. So about 63% of requests hit at least one slow server. The paper uses exactly this example: servers that "typically respond in 10ms but with a 99th-percentile latency of one second", and with 100 of them "63% of user requests will take more than one second."

I ran the same thing in the simulation, 20,000 requests that each fan out to 100 copies of my server:

```
fan-out 100   >1s 63.0%   p50 1008.0 ms
theory 1-0.99^100 = 63.4%
```

The rare stall on one server became the *normal* experience for the whole service. Even the median request took a second.

It gets worse with more servers. The paper says that if only 1 call in 10,000 is slow, a service with 2,000 servers "will see almost one in five user requests taking more than one second."

Google measured this on a real service too. The paper's Table 1 shows how long a request takes to finish at the root of the fan-out tree:

```
                 p50    p95    p99
one random leaf  1ms    5ms    10ms
95% of leaves    12ms   32ms   70ms
all leaves       40ms   87ms   140ms
```

Waiting for one leaf costs 10 ms at the p99. Waiting for all of them costs 140 ms. And half of that, 70 ms, is spent waiting for the slowest 5%.

## Where the slowness comes from

The paper lists the usual causes. None of them are bugs. They're things every real system does:

- **Shared resources.** Other programs on the same machine compete for CPU, caches, memory bandwidth and the network.
- **Background daemons** that are idle most of the time but cause "multi-millisecond hiccups" when they run.
- **Maintenance work** like log compaction and garbage collection.
- **Queueing** in servers and network switches, which amplifies all of the above.
- **Hardware**: CPUs that throttle when they get hot, SSDs that pause for their own garbage collection, and power-saving modes that take time to wake up.

The paper's conclusion is that you can't remove all of this, so you have to build systems that cope with it. It compares this to fault tolerance: just as you build a reliable system out of unreliable parts, you build a "predictably responsive whole out of less-predictable parts."

One thing that does *not* fix it is a cache. The paper says caches "do not directly address tail latency", unless the whole working set fits in the cache.

## Measuring it honestly

Before fixing the tail, you have to see it, and most load-testing tools hide it by accident. Gil Tene, who wrote the load tester wrk2, calls the problem *coordinated omission*.

A typical load tester sends a request, waits for the reply, and then sends the next one. If the server freezes for a second, the tester freezes with it. It records one slow request, and it doesn't send the hundred requests it was meant to send during that second. As the wrk2 README puts it, the load generator ends up "coordinating with the server to avoid measurement during high latency periods."

I simulated this too: a 10-second test planned at 100 requests per second, against a server that answers in 1 ms but freezes for one second in the middle.

```
measured from    p99     >100ms
actual send      1 ms    1 of 1000
planned send     920 ms  101 of 1000
```

Same server, same freeze. Measured the usual way, the p99 is 1 ms and only one request looks slow. Measured from when each request *should* have gone out, which is what wrk2 does, the p99 is 920 ms and about 100 requests were hit. A real user doesn't wait politely for the previous user's request to finish, so the second line is the true one.

## Living with the tail

Most of the paper is about techniques that accept that some servers will be slow and work around them.

**Hedged requests.** Send the request to one replica. If it hasn't answered after a short delay, send the same request to a second replica, use whichever answer comes first, and cancel the other. The trick is choosing the delay. The paper suggests waiting until the request has been outstanding longer than the 95th-percentile time, which "limits the additional load to approximately 5% while substantially shortening the latency tail." I go deeper on this, including where the code lives and why you must never hedge a plain write, in [hedged requests explained](/blog/posts/hedged-requests-explained/).

I added that to my simulation: if a call hasn't answered by the p95 (14.6 ms in my numbers), send a second one.

```
              >1s     p50      p99     extra
no hedge      63.0%   1008 ms  1015 ms  0.0%
hedge @ p95   0.8%    22.7 ms  29.6 ms  4.9%
```

About 5% more requests, and the share of slow requests fell from 63% to under 1%. Google's own numbers are similar. In a benchmark that reads 1,000 keys from BigTable spread over 100 servers, hedging after 10 ms cut the p99.9 "from 1,800ms to 74ms while sending just 2% more requests."

**Tied requests.** Hedging still means a few requests run twice. A tied request goes to two servers at once, and each copy knows about the other. Whichever server starts on it first tells the other to drop its copy. In Google's file system test this cut the p99.9 from 98 ms to 61 ms, with less than 1% extra disk use.

**Longer-term fixes.** The paper describes a few more:

- **Micro-partitions:** split the data into many more pieces than machines (about 20 per machine), so load can be moved in small steps. It's the same idea as the virtual nodes in [consistent hashing](/blog/posts/consistent-hashing-explained/).
- **Latency-induced probation:** temporarily take a particularly slow server out of rotation, keep sending it test requests, and bring it back when it recovers.
- **Good enough:** for search, answer once most of the servers have replied instead of waiting for the slowest. The paper notes the chance that a given server holds the best result is under one in 1,000.
- **Canary requests:** send a new query to one or two servers first. If it crashes them, it never reaches the other thousands.

## Where you'll see it

Hedging is built into gRPC. Its retry design (gRFC A6) has a `hedgingPolicy` with a maximum number of attempts and a `hedgingDelay` between them. One detail surprised me: the document's header lists it as implemented in Java, .NET and Node, but "Go except hedging, and C-Core except hedging". So whether you can switch it on depends on which language your client is written in. If gRPC itself is new to you, I wrote a [separate post on what gRPC is](/blog/posts/grpc-explained/).

## The catches

- **Only for safe requests.** The gRPC document warns that hedging should only be enabled for methods "that are safe to execute multiple times." Reads are fine. Charging a card twice is not.
- **Only for independent slowness.** Hedging works because the second replica is probably fine. The paper says these techniques work only when the cause of slowness "does not tend to simultaneously affect multiple request replicas." If every replica is slow because the database behind them all is slow, a second request just adds load. My simulation makes every stall independent, which is the best case.
- **It costs load.** Hedge too early and you're sending far more than 5% extra, which can make an already busy system slower. This is why gRPC also throttles hedges when too many requests are failing.

## The one-paragraph version

Tail latency is the slow end of the latency distribution: the p99 and p99.9, not the average, which describes no real request. It matters because big systems fan out. If one request waits for 100 servers that are each slow 1% of the time, 63% of requests are slow, and my Pi simulation landed on exactly that. Measure from when a request should have been sent, or your load tester will hide the tail from you. You can't remove every source of slowness, so you work around it: hedged requests after the p95 cut my simulated slow share from 63% to under 1% for about 5% extra load. They only help with independent slowness and with requests that are safe to send twice.

## Where I learned this

These are the sources I read while writing this post. The numbers from my Pi come from two small Python simulations (Python 3.13.5, run on 2026-10-21), not from a real cluster:

- [Jeffrey Dean and Luiz André Barroso, *The Tail at Scale*, Communications of the ACM 56(2), February 2013](https://www.barroso.org/publications/TheTailAtScale.pdf). The 63% example, Table 1, the causes of variability, hedged and tied requests, and the longer-term techniques.
- [gRPC proposal A6: gRPC Retry Design](https://github.com/grpc/proposal/blob/master/A6-client-retries.md). The `hedgingPolicy` settings, the safety warning, and which languages implement it.
- [Gil Tene, wrk2 README](https://github.com/giltene/wrk2). Coordinated omission and measuring from the intended send time.
