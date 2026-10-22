---
title: "The bulkhead pattern: keeping one slow dependency from sinking everything"
description: "How one hanging dependency can use up a shared thread or connection pool and take healthy features down with it, and how giving each dependency its own bounded pool contains the damage."
date: 2026-10-21
category: tech
tags: ["backend-concepts", "distributed-systems", "resilience", "bulkhead"]
draft: false
---

The [last Backend Concepts post](/blog/posts/consistent-hashing-explained/) was about spreading data across many machines. This one is about what happens when one of the things your service depends on stops answering. Usually that isn't a crash. The dependency just gets slow, and that turns out to be worse. The bulkhead pattern is the usual defence. These are my notes on it.

## Where the name comes from

A ship's hull is split into sealed sections by walls called bulkheads. If the hull is breached, only the damaged section floods and the ship stays afloat. Without them, one hole lets water into the whole hull.

In software the idea is the same. Split your resources into separate compartments, so a problem in one part can only use up that part's share. Microsoft's architecture guide defines it as isolating "the elements of an application into pools so that if one element fails, the others continue to function." The name in software goes back to Michael Nygard's book *Release It!*, which lists Bulkheads as a stability pattern next to Timeouts and Circuit Breaker.

## The problem: one slow dependency, one shared pool

Picture a service that calls two others: A (say, recommendations) and B (say, login). Every outgoing call needs a worker thread, or a connection from a connection pool. There's only a limited number of those, and both kinds of call share them.

Now A starts hanging. It doesn't return an error. It just takes seconds to answer. Every call to A grabs a worker and holds it. New requests keep coming, so more and more workers sit waiting on A. Soon every worker is stuck on A, and a call to B has nothing to run on. B is perfectly healthy, but your service can't reach it any more.

Microsoft's guide describes exactly this: requests to an unresponsive service tie up the caller's resources, the client's connection pool runs dry, and "eventually, the consumer can't send requests to any other services, not only the original unresponsive service." The failure has cascaded from A to everything.

A clean crash would have been kinder. A failed call to A returns at once and frees its worker. A slow call keeps the worker busy for as long as it's stuck.

## Trying it

I wanted to see this rather than take it on trust, so I wrote a small Python script and ran it on my Pi (Python 3.13.5). A is a fake call that sleeps for 2 seconds. B sleeps for 10 milliseconds. The script fires 20 calls at A, then 5 calls at B, and measures how long the B calls take to finish.

First with one shared pool of 10 threads, then with two separate pools: 8 threads for A and 2 for B.

```python
import time
from concurrent.futures import ThreadPoolExecutor

def slow_a(): time.sleep(2.0)    # A hangs
def fast_b(): time.sleep(0.01)   # B is fine

def run(pool_a, pool_b):
    t0 = time.monotonic()
    for _ in range(20):
        pool_a.submit(slow_a)
    fb = [pool_b.submit(
            lambda: (fast_b(),
                     time.monotonic() - t0)[1])
          for _ in range(5)]
    return max(f.result() for f in fb)

shared = ThreadPoolExecutor(max_workers=10)
print("shared:", run(shared, shared))

a = ThreadPoolExecutor(max_workers=8)
b = ThreadPoolExecutor(max_workers=2)
print("bulkheads:", run(a, b))
```

The output of the full script (the core is above; the real one also prints labels):

```
shared pool of 10:      B waited 4.01s
bulkheads A=8 / B=2:    B waited 0.03s
```

With the shared pool, the 20 calls to A filled all 10 threads and queued 10 more ahead of B. B's calls, each needing 10 ms, waited 4 seconds behind two waves of A. With separate pools, A could only ever fill its own 8 threads. B's 2 threads stayed free, and B finished in 30 ms, as if nothing was wrong.

That's the whole pattern in one experiment. A is just as broken in both runs. The bulkhead doesn't fix A. It stops A's problem from spreading to B.

## The fix: a bounded pool per dependency

The textbook bulkhead is what the second run did: give each dependency its own pool with its own limit. Microsoft's guide puts it as "a consumer that calls multiple services might be assigned a connection pool for each service. If a service begins to fail, it only affects the connection pool assigned for that service."

Two details matter in practice:

- **Bound the queue, not just the pool.** In my demo, A's pool still queued every call, so A's callers waited longer and longer. A real bulkhead also caps how many calls may wait, and rejects the rest straight away. A fast "no" is better than a slow one, because it frees the caller and lets it show a fallback.
- **Pair it with timeouts and a circuit breaker.** The bulkhead limits how much a slow dependency can hold. A timeout limits how long each call can hold it. A circuit breaker stops calling a dependency that keeps failing. Microsoft's guide recommends combining bulkheads with retry, circuit breaker and throttling.

## Threads or semaphores

There are two common ways to build the compartment, and libraries usually offer both.

**A thread pool per dependency.** Calls to A run on A's own threads. Because the call runs on a separate thread, the caller can stop waiting after a timeout and walk away, even if A never answers. Netflix's Hystrix library worked this way by default. Its docs say it uses "the bulkhead pattern to isolate dependencies from each other and to limit concurrent access to any one of them". Netflix measured the cost of the extra thread hop at 60 requests per second: nothing at the median, about 3 ms at the 90th percentile, and about 9 ms at the 99th.

**A semaphore per dependency.** No extra threads. It's a counter that allows at most N calls to A at once and rejects the next one. It's cheaper, but the calling thread itself is the one stuck on A. In the Hystrix docs' words, a semaphore sheds load but "does not allow for timing out and walking away." They suggest semaphores for very fast calls, like in-memory cache lookups, where the thread overhead isn't worth it.

Resilience4j, the library Hystrix's own README now points people to, has both: a `SemaphoreBulkhead` (default `maxConcurrentCalls` is 25) and a thread-pool bulkhead with a bounded queue (default `queueCapacity` is 100). Hystrix itself is in maintenance mode, and its README says Netflix uses resilience4j for new internal projects.

## Bulkheads at other levels

The same idea works well beyond thread pools:

- **Connection pools.** A separate database or HTTP connection pool per dependency, so one slow backend can't take every connection.
- **Proxies.** Envoy's "circuit breaking" settings are really bulkheads: per upstream cluster, it caps connections, pending requests, active requests and retries. The defaults are 1,024 connections, 1,024 pending requests, 1,024 requests and 3 retries. Calls over a limit fail fast and bump an overflow counter.
- **Processes and containers.** Run services in separate containers with their own CPU and memory limits. Microsoft's guide says containers "offer a good balance of resource isolation with fairly low overhead," and its example is a Kubernetes pod with `requests` and `limits` set.
- **Queues.** Give each kind of message its own queue and its own workers, so a flood of one kind can't starve the others.
- **Customers.** Split service instances into groups and assign customers to them, so one customer sending far too much traffic can only overwhelm its own group. Microsoft says this approach is also known as a *cell-based architecture*.

## Shuffle sharding: a sharper bulkhead for customers

The last one has a weakness. Say you have 8 workers split into 4 fixed groups of 2. If one customer's traffic breaks its group, every customer in that group goes down with it, about 25% of everyone.

AWS's Builders' Library describes a trick called shuffle sharding. Instead of fixed groups, each customer gets its own random pair out of the 8 workers. There are 28 different pairs, so a bad customer takes out only 1/28 of the possible combinations. Any other customer shares at most one worker with it and still has the other one. AWS says this is about 7 times better than plain sharding. Route 53 uses it at a much bigger scale: 2,048 virtual name servers with 4 per customer domain gives about 730 billion combinations. I checked that sum in Python: choosing 4 out of 2,048 gives 730,862,190,080.

## What it costs

Bulkheads aren't free:

- **Idle capacity.** In my demo, B's 2 threads sat mostly idle while A's 8 were overloaded. A shared pool would have used all 10. Microsoft's guide says the pattern may not suit a project where "less efficient use of resources" isn't acceptable.
- **Sizing.** Every pool needs a limit. Set it too small and you reject good traffic. Set it too big and the compartment no longer protects anything.
- **More to watch.** Each compartment needs its own metrics, so you can see which one is full.

## The one-paragraph version

When a dependency gets slow, every call to it holds a thread or a connection for a long time. If all your calls share one pool, the slow dependency eats the whole pool and healthy features stop working too. In my demo, a 10 ms call waited 4 seconds behind a hung one. A bulkhead gives each dependency its own bounded pool, so a problem can only use up its own share. In the demo, that brought the healthy call back to 30 ms. Bound the queue so overflow is rejected fast, and pair it with timeouts and a circuit breaker. The same idea scales up to connection pools, Envoy limits, containers with resource limits, separate queues, and per-customer cells with shuffle sharding. The price is some idle capacity and limits you have to size.

## Where I learned this

These are the pages I read while writing this post. Each claim above comes from one of them, apart from the demo numbers, which come from running the script on my Pi:

- [Microsoft Azure Architecture Center: Bulkhead pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead). The definition, the connection-pool failure story, considerations, and when not to use it.
- [Michael Nygard, *Release It!* (2nd ed., 2018)](https://pragprog.com/titles/mnee2/release-it-second-edition/). Bulkheads, Timeouts and Circuit Breaker as stability patterns. I read the table of contents, not the chapter.
- [Netflix Hystrix: How it Works](https://github.com/Netflix/Hystrix/wiki/How-it-Works). Thread-pool isolation, its measured cost, and semaphores. Its [README](https://github.com/Netflix/Hystrix) has the maintenance-mode note.
- [Resilience4j: Bulkhead](https://resilience4j.readme.io/docs/bulkhead). The semaphore and thread-pool bulkheads and their defaults.
- [Envoy: Circuit breaking](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking) and [its threshold defaults](https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/circuit_breaker.proto).
- [AWS Builders' Library: Workload isolation using shuffle sharding](https://aws.amazon.com/builders-library/workload-isolation-using-shuffle-sharding/).
