---
title: "Consistent hashing: what it is and what it solves"
description: "Why hash mod N reshuffles almost every key when you add a server, how the consistent hashing ring moves only a few, and why virtual nodes fix the uneven load."
date: 2026-10-20
category: tech
tags: ["backend-concepts", "distributed-systems", "caching", "consistent-hashing"]
draft: false
---

The [last two](/blog/posts/write-ahead-logging-explained/) [Backend Concepts posts](/blog/posts/change-data-capture-explained/) were about a single database and its log. This one is about what happens when the data doesn't fit on one machine: how do you decide which machine each piece of data lives on, in a way that doesn't fall apart the moment you add one more? The answer most systems use is called consistent hashing. These are my notes on it.

## The problem: spreading keys over servers

Say you have a cache split across 4 servers. Every item has a key, like `user:42`, and every client needs to agree on which server holds it. You don't want a central lookup table that every request has to ask first. You want each client to work out the server from the key alone.

The obvious way is to hash the key and take the remainder:

```
server = hash(key) % 4
```

The hash spreads keys evenly, the remainder picks one of 4 servers, and every client gets the same answer. It works well, until the number of servers changes.

## Why `hash % N` breaks when N changes

Add a fifth server, and the formula becomes `hash(key) % 5`. For almost every key, `% 5` gives a different answer than `% 4` did. A key only stays put if both remainders happen to match, and for evenly spread hashes that's about 1 in 5. So **about 80% of keys move to a different server**.

For a cache, that means 80% of lookups suddenly miss, all at once, and the database behind the cache takes the full load. For a database, it means copying 80% of your data around. And it's the same when a server dies and N drops from 5 to 4.

The nginx docs say it plainly for their plain `hash` load-balancing method: adding or removing a server "may result in remapping most of the keys to different servers."

What you want is this: when one server joins, it takes its fair share (1/5 of the keys) and nothing else moves.

## The ring

Consistent hashing comes from a 1997 paper by Karger and others, written to spread web caching load and relieve hot spots. The way Amazon's Dynamo paper describes it is the clearest I found:

1. Take the output range of the hash function and bend it into a circle, so the largest value wraps around to the smallest. This is the ring.
2. Hash each **server** to get a position on the ring.
3. Hash each **key** to get a position on the same ring.
4. A key belongs to the first server you reach walking **clockwise** from the key's position.

So each server owns the stretch of ring between the previous server and itself.

Now see what happens when a server joins. It lands at one spot on the ring and takes over the keys between its new neighbour behind it and itself. Those keys used to belong to the next server clockwise. **No other key moves.** When a server leaves, its keys go to the next server clockwise, and again nothing else moves. In Dynamo's words, a node arriving or leaving "only affects its immediate neighbors and other nodes remain unaffected."

## The catch: one spot per server is lumpy

With one random position per server, the gaps between servers come out very uneven. One server might own a huge arc of the ring and another a tiny one. The Dynamo paper names this as the first problem with the basic algorithm: random positions lead to "non-uniform data and load distribution." The second problem is that it treats every server as equal, even when some are bigger than others.

It also means a new server takes its keys from just one neighbour, not a bit from everyone. And when a server dies, its whole load lands on one neighbour.

## Virtual nodes

The fix is to give every server many positions on the ring instead of one. Dynamo calls these virtual nodes, or tokens. A server with 100 tokens appears at 100 spots, so it owns 100 small arcs scattered around the ring instead of one big one. The random lumps average out.

The Dynamo paper lists what this buys you:

- When a server goes down, its load spreads evenly across all the others, not onto one neighbour.
- When a server joins, it takes a roughly equal amount from every other server.
- A bigger server can simply get more tokens, so it gets a bigger share.

Cassandra does the same thing and calls them vnodes. Its docs mention that in Cassandra 2.x, with randomly chosen tokens, the default was 256 tokens per node. Newer versions place tokens more carefully, so they get a balanced ring with far fewer.

## Trying it

I wanted to see the numbers rather than take them on trust, so I wrote a small Python script and ran it on my Pi (Python 3.13.5). It puts 100,000 keys on 4 servers, adds a fifth, and counts how many keys changed server. It also prints the fewest and most keys any server ended up with. Here is the core of it:

```python
import hashlib, bisect

def h(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:16], 16)

KEYS = [f"user:{i}" for i in range(100_000)]

def mod_n(n):
    return {k: h(k) % n for k in KEYS}

def ring(n, vnodes):
    pts = sorted((h(f"server{s}#{r}"), s)
                 for s in range(n) for r in range(vnodes))
    hs = [p[0] for p in pts]
    # first point clockwise; wrap past the top back to 0
    return {k: pts[bisect.bisect(hs, h(k)) % len(pts)][1]
            for k in KEYS}
```

The output, trimmed to the interesting parts:

```
              moved   keys per server (min / max)
mod N         79.9%   4 servers: 24851 / 25194
ring, 1 pt     9.0%   4 servers: 10134 / 42472
ring, 100 pts 22.4%   4 servers: 22248 / 27397
```

A few things stand out:

- **`hash % N` moved 79.9% of the keys**, just as the maths said. Its load is perfectly even, though.
- **The ring with one point per server moved only 9%.** That sounds great, but look at the load. One server held 42,472 keys and another 10,134, a 4x difference. The new server also only got 9% of the keys, not its fair 20%, because its one random spot happened to land in a small gap.
- **The ring with 100 points per server moved 22.4%**, close to the ideal 20%, and the busiest server held only about 23% more than the quietest.

I also checked one more thing in the script: on the ring, every key that moved went to the new server. No key moved between the 4 old servers.

## Replicas: keep walking

The ring also gives you an easy way to place copies. Dynamo stores each key on the server that owns it and then on the next N−1 servers clockwise. The list of servers for a key is called its preference list. With virtual nodes, the next few positions might belong to the same physical server, which would defeat the point of having copies. So Dynamo skips positions until the list has only distinct physical servers. Cassandra's docs describe the same walk.

## Where it shows up

- **nginx:** `hash $key consistent;` in an upstream block switches to the ketama consistent hashing method. Its docs say only a few keys get remapped when a server is added or removed, which "helps to achieve a higher cache hit ratio for caching servers."
- **Envoy:** the ring hash load balancer works the way described above, and its docs say adding or removing one host out of N affects only 1/N of requests. Envoy also offers **Maglev**, which uses a fixed lookup table (65,537 entries by default) instead of a ring. It's much faster to build and to look up, but moves more keys when hosts change.
- **Databases:** Dynamo, and Cassandra with its token ring.

## Two newer twists

**Jump consistent hash** (Lamping and Veach at Google, 2014) needs no ring and no memory at all. It's about five lines of code and divides keys more evenly than the ring. Its catch is that servers must be numbered 0 to N−1, so you can grow or shrink from the end but can't remove server 2 out of the middle. The paper says that makes it better suited to data storage than to web caching.

**Consistent hashing with bounded loads** (Google, 2017) caps how full any one server can get: at most a little over the average load. A key whose server is full keeps walking clockwise to the next one with room. Google used it in Cloud Pub/Sub, and Vimeo added it to HAProxy, where Google's post says it cut their cache bandwidth by a factor of almost 8.

## The one-paragraph version

To spread keys over servers, `hash(key) % N` is simple and even, but changing N moves about 80% of keys. Consistent hashing puts servers and keys on the same ring, and each key goes to the next server clockwise. Adding or removing a server then moves only the keys next to it, about 1/N of them. One spot per server leaves the load lumpy, so real systems give each server many virtual nodes. Copies go on the next distinct servers around the ring. You'll find it in nginx's `hash ... consistent`, Envoy's ring hash and Maglev, Dynamo and Cassandra.

## Where I learned this

These are the pages I read while writing this post. Each claim above comes from one of them, apart from the simulation numbers, which come from running the script on my Pi:

- [Dynamo: Amazon's Highly Available Key-value Store (2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf). Sections 4.2 and 4.3: the ring, the problems with one position per node, virtual nodes, and the preference list. Its reference list cites the original Karger et al. 1997 paper, "Consistent hashing and random trees".
- [Apache Cassandra: Dynamo architecture](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html). The token ring, vnodes, and placing replicas on distinct nodes.
- [nginx: upstream `hash` directive](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#hash). Plain hashing vs `consistent` (ketama).
- [Envoy: Supported load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers). Ring hash and Maglev.
- [Lamping and Veach: A Fast, Minimal Memory, Consistent Hash Algorithm (2014)](https://arxiv.org/abs/1406.2294). Jump consistent hash.
- [Google Research: Consistent Hashing with Bounded Loads (2017)](https://research.google/blog/consistent-hashing-with-bounded-loads/)
