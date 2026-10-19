---
title: "Change data capture (CDC): what it is and what it solves"
description: "What change data capture is, why dual writes and polling fall short, how log-based CDC reads the database's own log, and what it costs."
date: 2026-10-18
category: tech
tags: ["backend-concepts", "databases", "postgres", "change-data-capture"]
draft: true
---

In the [last Backend Concepts post](/blog/posts/write-ahead-logging-explained/) I learned that databases write every change to a log before they touch the real data. That log exists for crash recovery. But while reading about it, I kept seeing the same log reused for something else: other programs reading it to find out what changed. That idea has a name, change data capture, or CDC. This post is my notes on what it is and the problem it solves.

## The problem: your data lives in more than one place

Picture an app with a `products` table in Postgres. Sooner or later, other systems need to know when a product changes:

- a search index, so the new price shows up in search
- a cache, so it stops serving the old price
- a data warehouse, for reports
- another service that sends "back in stock" emails

The database is the source of truth. The question is how everything else finds out that the truth changed.

## Two obvious fixes, and why they break

**Fix 1: write to both places from the app.** After saving the product, the app also sends a message to the search index or a queue. This is called a dual write, and the trouble is that the two writes aren't one transaction. If the database commit succeeds and the message send fails, or the app crashes in between, the two systems now disagree. Nothing tells you they disagree, either. Wrapping both in a single distributed transaction (two-phase commit) is usually not an option, because the database or the message broker may not support it.

**Fix 2: poll the table.** Add an `updated_at` column and have a job run something like this every minute:

```
select * from products
where updated_at > :last_run;
```

This works, up to a point. It needs that column on every table you care about. It never sees deletes, because a deleted row isn't there to select. If a row changes three times between polls, you only see the last version. And there is always a delay of up to one polling interval, plus the load of running the query again and again.

## The idea: read the log the database already keeps

The database already records every insert, update and delete, in order, in its log. That log is what made crash recovery possible in the WAL post. CDC tools read that same log and turn each change into an event that other systems can consume.

That's what change data capture means: capturing each change to the data as it happens and handing it to someone else as a stream. The kind that reads the database's log is called log-based CDC. The polling approach above is sometimes called query-based CDC.

Reading the log fixes the problems from both fixes:

- **Every change is captured**, in order, including deletes and every intermediate update.
- **No schema changes.** You don't need an `updated_at` column.
- **Low delay, no polling.** Changes arrive shortly after they commit, without running a query every minute.
- **Old values too.** An event can carry the row before and after the change.
- **No dual write.** The app writes only to the database. If the commit happened, it's in the log, so the event will go out.

## How each database exposes its log

Every database has a log, but each exposes it in its own way.

**Postgres: logical decoding.** The WAL describes changes at the storage level, as bytes on pages. Logical decoding turns that into rows: "this row was inserted into this table". To use it you set `wal_level = logical`, which needs a server restart. A consumer then reads through a replication slot, which keeps track of how far that consumer has got. An output plugin decides the format. `pgoutput` is built in, and `test_decoding` prints plain text, which is handy for trying it out.

**MySQL: the binary log.** MySQL's binlog records changes to table data, and it's the same log MySQL uses to send changes to replicas. CDC tools connect to it the way a replica would.

**MongoDB: change streams.** MongoDB keeps the oplog (short for "operations log"), a capped collection holding a rolling record of every operation that modifies data. It's the log that replica set members copy to stay in sync. It's not the same thing as the WiredTiger journal from the WAL post: the journal is for crash recovery on one server, and the oplog is for replication. Instead of making you read the oplog directly, MongoDB offers change streams. You subscribe to a collection, a database or the whole deployment and receive changes as they happen. Change streams only work on replica sets and sharded clusters. Each event carries a resume token, so a consumer that disconnects can pick up where it stopped.

## What a change event looks like

Debezium, the best-known open-source CDC tool, turns each change into an event shaped roughly like this (simplified, not real output):

```
{
  "op": "u",
  "before": { "id": 7, "price": 499 },
  "after":  { "id": 7, "price": 449 },
  "source": { "table": "products", ... }
}
```

`op` says what happened: `c` for create, `u` for update, `d` for delete. `before` and `after` are the row on either side of the change. `source` says where the change came from, including the table, the transaction and the position in the log. That's enough for a consumer to update a search index, invalidate a cache entry or write a row to a warehouse.

## Snapshot first, then stream

The log doesn't go back forever. Postgres eventually removes WAL it no longer needs, and MongoDB's oplog is capped. So when a CDC tool starts for the first time, it usually takes a snapshot: it reads the current contents of the tables and sends them as events. After that, it switches to streaming new changes from the log. This way a new consumer gets the whole current state and then every change after it.

## Debezium, and where the events go

Most often Debezium runs as a set of Kafka Connect connectors. Each one reads a database's log and writes the events into Kafka topics, and from there other connectors carry them on to things like Elasticsearch or a data warehouse. You can also run it as Debezium Server, which sends events to other systems such as Amazon Kinesis, Google Cloud Pub/Sub or Apache Pulsar without Kafka. Or you can embed it as a library in a Java application.

## The outbox pattern: CDC for your own events

CDC sends out table changes. Often, though, you want to publish a business event like "order placed" instead of "a row in `orders` changed". The outbox pattern does that without bringing back the dual-write problem:

1. In the same transaction that saves the order, also insert a row into an `outbox` table describing the event.
2. CDC reads the `outbox` table's changes from the log and publishes each row as a message.

Because the order and the outbox row are committed together, you never get one without the other. The database transaction does the job that two-phase commit couldn't. Debezium even ships an "outbox event router" for exactly this.

## What it costs

CDC is not free, and the costs are easy to miss:

- **A stuck consumer can fill the disk.** A Postgres replication slot keeps every bit of WAL its consumer hasn't read yet, and it does this even when nothing is connected. If the consumer dies and nobody notices, WAL piles up. The Postgres docs warn that, in extreme cases, this can make the database shut down. Slots you no longer use should be dropped.
- **More WAL.** `wal_level = logical` writes extra information into the log, so the log gets bigger. The change also needs a restart.
- **Duplicates after a crash.** Debezium's FAQ says each event is seen exactly once while things run normally. After a crash, consumers may see some events again. Anything consuming the events has to cope with seeing the same change twice.
- **Another moving part.** You now run a connector, often Kafka too, and you have to watch it. Polling is crude, but it's one SQL query.

## The one-paragraph version

Other systems need to know when your data changes. Writing to two places from the app can silently drift apart, and polling misses deletes and intermediate changes. Change data capture reads the log the database already keeps (Postgres's WAL through logical decoding, MySQL's binlog, MongoDB's oplog through change streams) and turns every committed change into an event. Take a snapshot to start, then stream. Use the outbox pattern when you want business events instead of row changes. In return you have to keep the consumer alive so the log doesn't pile up, and handle the occasional duplicate.

## Where I learned this

These are the pages I read while writing this post. Each claim above comes from one of them:

- [Debezium: Features](https://debezium.io/documentation/reference/stable/features.html). What log-based CDC captures that polling can't, and snapshots.
- [Debezium: Architecture](https://debezium.io/documentation/reference/stable/architecture.html). Kafka Connect, Debezium Server and the embedded engine.
- [Debezium: PostgreSQL connector](https://debezium.io/documentation/reference/stable/connectors/postgresql.html). The shape of a change event, and the `pgoutput` plugin and replication slots.
- [Debezium: Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- [Debezium: FAQ](https://debezium.io/documentation/faq/). Duplicate events after a crash.
- [microservices.io: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html). The dual-write problem and why two-phase commit isn't the answer.
- [PostgreSQL: Logical decoding concepts](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html). Replication slots, output plugins, and the warning about WAL retention.
- [PostgreSQL: WAL settings](https://www.postgresql.org/docs/current/runtime-config-wal.html). `wal_level = logical`, the restart, and the extra WAL volume.
- [MySQL: The binary log](https://dev.mysql.com/doc/refman/8.4/en/binary-log.html)
- [MongoDB: Change streams](https://www.mongodb.com/docs/manual/changeStreams/)
- [MongoDB: Replica set oplog](https://www.mongodb.com/docs/manual/core/replica-set-oplog/)
