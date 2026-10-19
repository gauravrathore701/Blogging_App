---
title: "Write-ahead logging (WAL): what it is and what it solves"
description: "What write-ahead logging (WAL) is, the crash problem it solves, how checkpoints work, and why SQLite, Postgres and MongoDB all use it."
date: 2026-10-18
category: tech
tags: ["backend-concepts", "databases", "sqlite", "write-ahead-logging"]
draft: false
---

I kept running into the letters WAL. SQLite has a `journal_mode=wal`. Postgres has a folder called `pg_wal`. People online say "just turn on WAL" as if it were a speed switch. I didn't know what it actually was, so this post is my notes from learning it: what the problem is, how a write-ahead log solves it, and what it costs.

This is the first post in a series I'm calling Backend Concepts. These are the ideas I keep seeing under the software I run, written down while I learn them.

## The problem: saving is not one step

Say a database needs to change one row. On disk, that row lives inside a page, a fixed-size block of the database file (SQLite uses 4 KB pages by default). To change the row, the database has to rewrite the page. One transaction often touches several pages: the row itself, an index that points to it, maybe a counter somewhere else.

Now pull the power cable halfway through.

Some pages have the new data and some still have the old data. A page might even be half written. The file is now in a state that never existed: not before the transaction, not after it. That is how a database gets corrupted. A database promises that a transaction happens completely or not at all (the "A" in ACID, atomicity). Writing pages straight into the file can't keep that promise on its own.

There is a second, quieter problem: speed. The pages a transaction touches are scattered around the file. Writing to scattered places is slow, and to be sure the data really reached the disk instead of sitting in the operating system's memory, the database has to call `fsync` (an "actually write this to the disk now and wait until it's done" request). Doing that for every page of every commit is expensive.

## The idea: write down what you're going to do first

Write-ahead logging solves this with one rule:

> Before you change the data file, write a description of the change to a log, and make sure that log entry is safely on disk.

The log is a separate file that is only ever appended to. A transaction goes like this:

1. Append the changes to the end of the log.
2. Append a "commit" record.
3. Flush the log to disk. **The transaction is now committed.**
4. Later, copy the changes into the real data file.

The data file can be updated whenever it's convenient. If the machine crashes before step 3, the commit record isn't in the log, so the transaction never happened, and the half-written entries get ignored. If it crashes after step 3 but before step 4, the database reads the log on its next start and replays the committed changes into the data file. This replay is called recovery.

Either way you end up with "all or nothing", which is exactly the promise we couldn't keep before.

It also fixes the speed problem. Appending to the end of one file is a sequential write, which disks handle much better than scattered ones. And at commit time only the log has to be flushed, not every page the transaction touched.

## Checkpoints: the log can't grow forever

If every change goes into the log, the log keeps growing. A checkpoint is the moment the database copies the changes from the log into the data file. After that, those log entries are no longer needed and the space can be reused.

In SQLite, a checkpoint runs automatically once the log reaches 1,000 pages. One thing that surprised me: by default the `-wal` file doesn't shrink after a checkpoint. SQLite just starts writing from the beginning of it again. If you want the disk space back, you have to ask for it explicitly:

```
pragma wal_checkpoint(TRUNCATE);
```

## Bonus: readers don't wait for writers

This part isn't about crashes at all, and it was the benefit I least expected.

SQLite's default mode is a rollback journal, which works the other way round. Before changing a page, it copies the old version into a `-journal` file, then changes the database file directly. If something goes wrong, it puts the old pages back. While the write is happening, the database file is in flux, so readers have to wait.

In WAL mode the database file isn't touched while a transaction is running. New data only exists in the log. A reader who starts in the middle of a write simply reads the data file plus the parts of the log that were already committed when it started. That gives it a consistent snapshot, and it doesn't have to wait. The writer doesn't have to wait for readers either.

Writers still take turns, though. SQLite allows one writer at a time even in WAL mode. If a second connection tries to write, it gets `database is locked`. So WAL doesn't give you concurrent writes. It gives you one writer and many readers who no longer block each other.

## The catch: durability is a setting

Remember step 3, "flush the log to disk"? That flush is where most of the cost is. Databases let you weaken it.

In SQLite this is `pragma synchronous`:

- `FULL`: flush the log on every commit. A committed transaction survives a power cut.
- `NORMAL`: in WAL mode, flush only around checkpoints, not on every commit. Much faster. If just the app crashes, nothing is lost. If the power goes or the OS crashes, the last few commits may roll back. The database stays consistent, though.
- `OFF`: never wait for the disk. Fastest, and an OS crash or power cut can corrupt the file.

I tried this once on my Raspberry Pi 5, on its SD card, with 1,000 small transactions. Switching from the rollback journal to WAL, with `FULL` on both, went from 173 to 326 commits per second. Switching WAL from `FULL` to `NORMAL` went from 351 to 12,050. That was one quick run on one SD card, so don't read much into the exact numbers. The shape is the lesson: most of the speed people credit to "turning on WAL" comes from the `synchronous=NORMAL` advice that usually comes with it. That's a durability trade, and it's worth making on purpose rather than by accident.

Postgres has the same knob, called `synchronous_commit`. Turning it off makes commits return before the log is flushed. That can lose the most recent transactions in a crash, but it doesn't corrupt the database.

## Where WAL is hiding on your machine

Once I knew what to look for, I kept finding it:

- **SQLite** files with `-wal` and `-shm` next to them. The `-wal` file is the log. The `-shm` file is a small index that tells readers which pages in the log are newest. Firefox and Chromium both keep their data this way, so you probably have some in your browser profile right now.
- **Postgres** writes every change to `pg_wal` before touching its tables. The same log is what replication streams to a standby server, and what point-in-time recovery replays.
- **MySQL's InnoDB** calls it the redo log.
- **MongoDB's WiredTiger** engine calls it the journal.
- **Filesystems** use the idea too. ext4's journal records changes to the filesystem's own structures before making them, so a crash doesn't leave the filesystem inconsistent.

The names differ, but it's the same rule every time: write down what you're about to do, make that note durable, and do the real work later.

## The one-paragraph version

Changing data in place can't survive a crash halfway through, and scattered writes are slow. A write-ahead log fixes both. Append the change to a log, flush it, and call it committed. Apply it to the real file later at a checkpoint, and replay the log after a crash. You get atomic commits, fast sequential writes, and readers that don't block the writer. The cost is a log you have to checkpoint, a single writer at a time in SQLite, and a durability setting you should choose deliberately.

## Where I learned this

These are the pages I read while writing this post. Each claim above comes from one of them:

- [SQLite: Write-Ahead Logging](https://www.sqlite.org/wal.html). How WAL works in SQLite, checkpoints, the 1,000-page autocheckpoint, the `-shm` index, one writer at a time.
- [SQLite: PRAGMA statements](https://www.sqlite.org/pragma.html#pragma_synchronous). What `synchronous` FULL, NORMAL and OFF promise, and `wal_checkpoint(TRUNCATE)`.
- [PostgreSQL: Write-Ahead Logging (WAL)](https://www.postgresql.org/docs/current/wal-intro.html). The core rule, why one sequential log flush is cheaper, and point-in-time recovery.
- [PostgreSQL: Asynchronous Commit](https://www.postgresql.org/docs/current/wal-async-commit.html). `synchronous_commit`, and why it risks lost transactions rather than corruption.
- [PostgreSQL: Log-Shipping Standby Servers](https://www.postgresql.org/docs/current/warm-standby.html). How replication streams WAL records to a standby.
- [MySQL: InnoDB Redo Log](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html)
- [MongoDB: Journaling](https://www.mongodb.com/docs/manual/core/journaling/). WiredTiger's journal is a write-ahead log.
- [Linux kernel: ext4 journal](https://www.kernel.org/doc/html/latest/filesystems/ext4/journal.html). By default ext4 journals metadata only.
