---
title: "Hedged requests: asking twice to beat the slow tail"
description: "How hedged requests cut the slow tail, why waiting until the p95 keeps the cost near 5%, where the code lives, and why you never hedge a plain write. Tested with real gRPC on a Pi."
date: 2026-10-22
category: tech
tags: ["backend-concepts", "distributed-systems", "latency", "grpc"]
draft: false
---

The [tail latency post](/blog/posts/tail-latency-explained/) ended with one trick that did most of the work: hedged requests. If a call is taking too long, send the same call to another server and use whichever answer arrives first. In my simulation it cut the share of slow requests from 63% to under 1% for about 5% extra load.

That's a big claim for such a small idea, and it left me with questions. Is the slowness one bad server, or something else? Where does the hedging code actually go? What happens if the call is a write? This post works through them, with a real gRPC hedge running on my Pi.

## First, what "slow" means here

Hedging only makes sense once you're clear about what it's fighting.

The slowness in the tail isn't one broken server. It's every server being slow *now and then*: a garbage collection pause, a queue that backs up for a moment, another program on the same machine taking the CPU. A server that answers in 10 ms 99 times out of 100 can still take a second on the hundredth. The next slow call will probably land on a different server.

A server that is slow *all the time* is a different problem. It's broken, and the fix is to take it out of rotation, with health checks, outlier detection, or the "latency-induced probation" from the last post. Hedging would hide it, but you'd be paying double for a broken server.

## Why one slow call in 100 hurts so much

The tail matters because of fan-out: one user request often waits for many servers, and it's only as fast as the slowest one.

If each server is fast 99% of the time, a request that waits for all of them is fast only if *every* server is fast. The chances multiply, 0.99 × 0.99 × … once per server:

```
servers  all fast  >=1 slow
      1     99.0%      1.0%
      2     98.0%      2.0%
     10     90.4%      9.6%
     50     60.5%     39.5%
    100     36.6%     63.4%
    500      0.7%     99.3%
```

That's where the 63% comes from: with 100 servers, only 36.6% of requests find all of them fast. You can't just add 1% a hundred times, because some requests hit two or three slow servers at once, so the real number climbs towards 100% without reaching it. No single server got worse; the request just rolled the dice more times.

## The idea

A hedged request does three things:

1. Send the request to one replica.
2. If there's no answer after a short delay, send the *same* request to a second replica.
3. Use whichever answer comes back first, and cancel the other one.

It works because the stalls are random. If one call stalls 1% of the time, both copies stalling is 1% × 1% = 0.01%. I checked that with a quick simulation of 100,000 single calls: the slow share went from 1.00% to 0.01%.

## Why wait until the p95

You could send two copies of every request straight away. That works, but it doubles the load on every server.

The delay is what keeps it cheap. Dean and Barroso's paper suggests waiting until the request has been outstanding longer than the 95th-percentile time. By definition, 95% of calls have answered by then, so only the slowest 5% ever get a second copy. A fast call never pays anything. You spend about 5% extra load, and you spend it only on calls that are already running late.

## Doing it for real on the Pi

My earlier numbers came from a pure simulation. This time I wanted real network calls, so I used gRPC: three replicas of a small service on my Pi, each answering in 5 to 15 ms but stalling for one second on 1 call in 100.

There's a twist. gRPC has hedging built in, but its retry design document (gRFC A6) lists it as implemented in "Java, .NET, Node, Go except hedging, and C-Core except hedging". Python's gRPC is built on C-Core, so a Python client has to hedge by hand. That turned out to be a good thing for a learner, because the whole technique fits in a dozen lines:

```python
async def hedged(stubs, req, delay):
    a, b = random.sample(stubs, 2)
    first = asyncio.ensure_future(a.GetUser(req))
    done, _ = await asyncio.wait({first}, timeout=delay)
    if done:
        return 0                      # answered in time
    second = asyncio.ensure_future(b.GetUser(req))
    done, pending = await asyncio.wait(
        {first, second}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()                    # tell the loser to stop
    done.pop().result()
    return 1                          # one extra request
```

The script first sends 4,000 plain calls and measures their p95. Then it sends 4,000 hedged calls with that p95 as the delay. I ran it with 4 calls in flight at a time, then 40 (Python 3.13.5, grpcio 1.84.0):

```
4 in flight      p99     p99.9    >1s   extra
no hedge       25.5 ms  1015.6 ms  38    -
hedge@16.3ms   25.0 ms    33.1 ms   0   3.5%

40 in flight     p99     p99.9    >1s   extra
no hedge       34.6 ms  1015.9 ms  38    -
hedge@18.2ms   36.5 ms    47.5 ms   0   6.7%
```

Out of 4,000 plain calls, 38 took over a second. With hedging, none did, and the p99.9 dropped from about a second to tens of milliseconds. The servers also logged 87 calls (in the first run) that were cancelled mid-flight. Those are the losing copies, stopped early instead of finishing work nobody would read.

Two things in these numbers taught me more than the headline did:

- **The cost isn't fixed at 5%.** An earlier run at 40 in flight sent 17.6% extra. The p95 I measured *before* hedging stops being the p95 once hedges add their own load, so more calls cross the line, and that adds more load. That's why real implementations put a budget on hedging, below.
- **I wrote a bug while measuring.** My first version counted extra requests with `extra += await fn()`. In Python's asyncio, that reads `extra` *before* the await and writes it back after, so concurrent calls overwrite each other's updates. It reported 95 extra requests when the servers had actually seen over a thousand. Counting on the server side as well is what caught it.

## Where the hedging code lives

Hedging always sits in the **caller**: whatever sends the request to the replicas. The servers don't change at all. They just see an ordinary request, and sometimes a cancellation.

```
user
 └─ frontend / aggregator   <- hedge here
     ├─ call -> replica A  (no reply by p95)
     │    └─ same call -> replica B
     ├─ call -> replica C
     └─ ...
```

There are three common places to put it.

**In the gRPC client config.** In languages that support it, you don't write code. You add a `hedgingPolicy` for a method in the client's service config:

```json
"hedgingPolicy": {
  "maxAttempts": 2,
  "hedgingDelay": "0.015s"
},
"retryThrottling": {
  "maxTokens": 10,
  "tokenRatio": 0.1
}
```

`maxAttempts` is capped: "Values greater than 5 are treated as 5." When one attempt succeeds, "all outstanding hedged requests are canceled." The `retryThrottling` block is the budget I mentioned. Every failed call removes a token, every successful call adds back `tokenRatio`, and hedges are only sent while the count stays above half of `maxTokens`. So when a service starts failing, the client stops piling extra copies onto it. My values above are an example, not tuned numbers.

**In a proxy next to the caller.** Envoy has a `hedge_on_per_try_timeout` setting on a route. When a try times out, Envoy sends another request, and its docs are explicit that this happens "without resetting the original request, leaving multiple upstream requests in flight." So unlike gRPC's hedging, Envoy doesn't cancel the first copy. Whichever good answer arrives first is used. I'd assumed both worked the same way until I read this.

**In your own code**, like the Python above. This is the most work, but you control the delay, the budget and the cancellation.

## When hedging doesn't help

Hedging works because the second replica is probably fine. If the slowness is *shared*, it isn't. Suppose every replica reads from the same database, and that database is slow for 1% of requests. Then the second copy hits the same slow database.

I simulated both cases with the same 1% slow rate and the same hedge delay:

```
           plain >1s  hedged >1s  extra
own stall    1.00%      0.01%     4.9%
shared slow  0.99%      1.01%     4.9%
```

With shared slowness, hedging paid the same 4.9% extra load and fixed nothing. The paper puts the condition plainly: these techniques work when the cause of slowness "does not tend to simultaneously affect multiple request replicas."

## Never hedge a plain write

Everything so far has been reads: fetch a user, search an index. A read can run twice and nothing changes.

A write is different. Hedge a "save user" call and both copies can succeed, and now you have two users. Or two emails sent, or two card charges. gRPC's design document says it's important that "hedging is only enabled for methods that are safe to execute multiple times without adverse affect." It usually doesn't help writes anyway. Writes tend to go to a single primary database, so both copies queue up in the same place, and you've added load to your busiest server.

Cancellation doesn't save you either. gRPC's docs say "Changes made before a cancellation are not rolled back." If the slow copy already wrote its row before the cancel arrived, the row stays. I show this in the [gRPC post](/blog/posts/grpc-explained/).

But writes still get duplicated without any hedging, through ordinary retries. If a call times out, you don't know whether it ran. So the real fix is to make writes safe to repeat with an **idempotency key**. AWS describes this in their Builders' Library: a "unique caller-provided client request identifier." The client makes the ID once and sends it with every copy. The server stores it with a uniqueness rule, so the second copy does nothing.

I tried both versions with SQLite (3.46.1), sending the same "save user" call twice:

```sql
INSERT INTO users (req_id, email)
VALUES (?, ?)
ON CONFLICT (req_id) DO NOTHING;
```

```
plain insert, sent twice:  2 users
with req_id, sent twice:   1 user  (rows written: 1, then 0)
```

The AWS article adds two details worth copying. The second copy should get the same answer the first one did, not an error. And if the same key arrives with *different* data, that's a client bug, so return a validation error.

So in practice:

- **Reads:** hedge them, with a delay around the p95 and a budget.
- **Writes:** don't hedge. Use a timeout and retry with an idempotency key.
- **Slow writes:** fix the write itself, or move it to a queue. A second copy won't make it faster.

## The one-paragraph version

Tail latency comes from every server being slow now and then, and fan-out turns that rare slowness into most of your requests. A hedged request sends a second copy to another replica if the first hasn't answered by about the p95, uses the first answer, and cancels the loser. Both copies stalling is rare, so the tail collapses: on my Pi, real gRPC calls over a second went from 38 in 4,000 to none, for 3.5% to 6.7% extra requests. The logic lives in the caller, as gRPC config, a proxy like Envoy, or your own code. It needs a budget, because the cost rises when hedges add load. It does nothing for slowness that every replica shares, and it must never be used on plain writes; those need idempotency keys.

## Where I learned this

The Pi numbers come from small Python scripts run on 2026-10-22 (Python 3.13.5, grpcio 1.84.0, SQLite 3.46.1). The gRPC test is real calls over loopback on one machine, not a cluster. The shared-versus-independent comparison is a simulation.

- [Jeffrey Dean and Luiz André Barroso, *The Tail at Scale*, CACM 2013](https://www.barroso.org/publications/TheTailAtScale.pdf). The p95 delay and the independence condition.
- [gRPC proposal A6: gRPC Retry Design](https://github.com/grpc/proposal/blob/master/A6-client-retries.md). `hedgingPolicy`, the cap of 5, cancellation on success, `retryThrottling`, the safety warning, and which languages implement hedging.
- [Envoy route configuration: HedgePolicy](https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/route/v3/route_components.proto) and [HTTP routing overview](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/http/http_routing). `hedge_on_per_try_timeout` and the original request being left in flight.
- [Malcolm Featonby, *Making retries safe with idempotent APIs*, Amazon Builders' Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). Client request identifiers, same response for a repeat, and the parameter-mismatch error.
- [gRPC core concepts](https://grpc.io/docs/what-is-grpc/core-concepts/). Cancellations don't roll back changes.
