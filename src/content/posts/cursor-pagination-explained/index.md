---
title: "Cursor pagination: what it is and why APIs use it"
description: "Why LIMIT/OFFSET gets slower the deeper you page and shows repeated or missing rows when data changes, and how cursor pagination fixes both by remembering the last row."
date: 2026-10-25
category: tech
tags: ["backend-concepts", "databases", "api-design", "pagination"]
draft: false
---

The last few Backend Concepts posts, up to [gRPC](/blog/posts/grpc-explained/), were about services talking to each other. This one is about something every API that returns a list runs into: how to hand the list out a page at a time. Most of us learn `LIMIT` and `OFFSET` first. Look at the APIs of Stripe or Slack, or at GraphQL, though, and you won't find a page number anywhere. You get a cursor instead. These are my notes on what a cursor is and why it won.

## Why paginate at all

A feed, an order history or a list of customers can have millions of rows. You can't send all of them in one response: it would be slow to build, huge to transfer, and the user only looks at the first screen anyway. So the API returns a small page, say 20 items, and the client asks for the next page when it needs it.

The question is how the client says "the next page".

## The obvious way: LIMIT and OFFSET

Number the pages. Page 1 is rows 1–20, page 2 is rows 21–40, and so on. In SQL:

```sql
-- page 3, 20 per page
SELECT * FROM posts
ORDER BY created_at DESC
LIMIT 20 OFFSET 40;
```

The API looks like `GET /posts?page=3`. It's simple, and you can jump straight to page 50. It has two problems, though, and both get worse as the data grows.

## Problem 1: deep pages get slower

`OFFSET 40` doesn't mean "start at row 41". The database still has to find rows 1 to 40, in order, and then throw them away. The PostgreSQL docs say it directly:

> The rows skipped by an OFFSET clause still have to be computed inside the server; therefore a large OFFSET might be inefficient.

The SQLite docs explain what happens inside: `LIMIT x OFFSET y` is computed as `LIMIT x+y`, and the first y rows are discarded. So the time grows with the offset. Page 1 is cheap. Page 50,000 has to walk past a million rows to return 20.

## Problem 2: rows shift under you

This one is a correctness bug, not a speed problem. An offset is just a count: "skip 20 rows". If the list changes between two requests, the same count points at different rows.

Say you're reading a feed, newest first, 5 per page. You load page 1. While you're reading, 3 new posts arrive at the top. Now you ask for page 2 with `OFFSET 5`. Everything has moved down by 3, so the first 3 rows of "page 2" are posts you already saw on page 1.

It also goes the other way. If 2 posts from page 1 get deleted, everything moves up by 2, and `OFFSET 5` jumps past 2 posts you never saw. Nothing errors. The user just sees duplicates or silently misses items. Markus Winand's [use-the-index-luke](https://use-the-index-luke.com/no-offset) makes the same point: you'll get duplicates when rows are inserted between fetching two pages.

## The cursor idea: remember where you stopped

Instead of counting rows, remember the **last row you returned**, and ask for the rows that come after it:

```sql
-- first page
SELECT * FROM posts
ORDER BY id DESC
LIMIT 20;

-- next page: last row of the previous
-- page had id 9481
SELECT * FROM posts
WHERE id < 9481
ORDER BY id DESC
LIMIT 20;
```

That "last row" value is the cursor. This approach is also called **keyset pagination** or the **seek method**.

Both problems go away:

- **Speed.** With an index on `id`, the database jumps straight to 9481 in the index and reads the next 20 entries. It doesn't matter whether that's page 2 or page 50,000.
- **Shifting rows.** New posts at the top have bigger ids, so `id < 9481` never returns them. A deleted post simply isn't there. The next page always starts right after the last thing you saw.

## Sorting by something that isn't unique

Sorting by `id` is easy because every id is different. Usually you want to sort by something like `created_at`, and many rows can share the same timestamp. If the cursor were only `created_at < '10:00:00'`, every other row stamped exactly 10:00:00 would be skipped.

The fix is to add a unique column as a tie-breaker, both to the sort and to the cursor. The cursor becomes a pair: the timestamp and the id of the last row.

```sql
SELECT * FROM posts
WHERE (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

`(created_at, id) < (?, ?)` is a **row value** comparison. It compares the way a dictionary sorts words: first by `created_at`, and only when those are equal, by `id`. PostgreSQL and SQLite both support it. The SQLite docs use exactly this pattern for a scrolling list of contacts and call it "much more efficiently than OFFSET", assuming there is a matching index.

That index matters. It should cover the sort columns in order:

```sql
CREATE INDEX posts_created_id
  ON posts (created_at, id);
```

Use-the-index-luke puts the rule simply: "Paging requires a deterministic sort order." Without a unique tie-breaker, rows that share a value can come back in any order, and a page boundary can land in the middle of them.

## What the API hands back: an opaque token

You could expose the raw values (`?after_created=...&after_id=...`), but most APIs wrap them into one string and tell clients not to look inside. The [Relay connection spec](https://relay.dev/graphql/connections.htm) for GraphQL says the cursor "should be considered opaque by the client". A common trick is plain base64 of a small JSON object:

```
{"c": 500, "id": 500000}
  -> eyJjIjogNTAwLCAiaWQiOiA1MDAwMDB9
```

Base64 isn't encryption. Anyone can decode it. The point of hiding it is that the server can change what's inside later (add a column, change the sort) without breaking clients, because clients never relied on the format. Treat the decoded values as untrusted input, the same as any other request parameter.

Here's how three real APIs shape it:

- **Stripe** uses object ids as cursors. You pass `starting_after=obj_foo` (the last object you got) to get the next page, or `ending_before` to go back. The response has `has_more`, which tells you whether there's anything after this page. `limit` defaults to 10 and goes up to 100.
- **Slack** returns `response_metadata.next_cursor`. An empty or missing `next_cursor` means there are no more results. Slack also warns that cursors expire and shouldn't be stored for hours or days.
- **GraphQL (Relay)** uses `first` / `after` to go forward and `last` / `before` to go back. Every item comes with its own `cursor`, and `pageInfo` has `hasNextPage` and `endCursor`.

The ideas are the same in all three: a page size, a token for "after this point", and a flag for "there's more".

## Trying it

I wanted to see both problems for myself, so I wrote a small Python script and ran it on my Pi (Python 3.13.5, SQLite 3.46.1). It fills a table with 1,000,000 posts, with an index on `(created_at, id)`. Lots of posts share a `created_at`, so the tie-breaker is needed. Then it fetches one page of 20 at different depths, both ways, and checks that both ways return the same rows.

Best of 20 runs, in milliseconds:

```
rows skipped   OFFSET   cursor
0              0.02     0.016
100,000        1.29     0.126
500,000        6.46     0.126
980,000       12.68     0.127
```

OFFSET grows in a straight line with depth: about 13 ms to skip 980,000 rows. The cursor stays flat at about 0.13 ms however deep it goes. This was an in-memory database, so the absolute numbers are tiny. On a real disk, with wider rows and many users at once, the gap only gets bigger. The shape is what matters: one grows, the other doesn't.

On shallow pages, OFFSET was actually a bit quicker than the cursor. Skipping 20 or 1,000 rows costs almost nothing. I think the cursor's extra 0.1 ms comes from the ties: SQLite's plan only used `created_at` to find the starting point, so it then had to step past the rows that share that timestamp.

SQLite's query plans show the difference:

```
OFFSET:  SCAN posts USING COVERING
         INDEX posts_created_id
cursor:  SEARCH posts USING COVERING
         INDEX posts_created_id
         (created_at<?)
```

SCAN means it walks the index from the start. SEARCH means it jumps into the index first.

Then the shifting-rows test, with 20 posts and 5 per page:

```
3 new posts arrive after page 1:
page 1     [20, 19, 18, 17, 16]
OFFSET 5   [18, 17, 16, 15, 14]
cursor     [15, 14, 13, 12, 11]

2 posts from page 1 deleted:
OFFSET 5   [13, 12, 11, 10, 9]
cursor     [15, 14, 13, 12, 11]
```

With new posts, OFFSET showed 18, 17 and 16 a second time. With deletions, it skipped 15 and 14, and the reader never saw them. The cursor got page 2 right both times.

## What you give up

Cursors aren't free. The trade-offs:

- **No jumping to page 37.** A cursor only knows "after this row". To reach page 37 you have to walk through the 36 before it. Use-the-index-luke argues this is fine for infinite scroll and "load more" buttons, which is how most feeds work now. It's a real loss for a UI with numbered pages.
- **Going backwards takes extra work.** To get the previous page, you flip both the comparison and the sort (`>` and `ASC`), then reverse the results before returning them. That's why Stripe has `ending_before` and Relay has `last`/`before`.
- **The cursor is tied to the sort.** A cursor made for "newest first" means nothing for "most liked first". If the client changes the sort or the filters, it has to start again from page 1.
- **No free total count.** Showing "page 3 of 812" needs a `COUNT(*)`, which has its own cost on a big table. Most cursor APIs just say "there's more" instead.
- **Cursors can go stale.** If the cursor points at a row that has since been deleted, a plain `WHERE (created_at, id) < (...)` still works, because it compares values and doesn't need the row to exist. If you instead store something like a server-side position, it can expire, which is why Slack tells clients not to keep cursors.

## When OFFSET is still fine

OFFSET isn't wrong. It's the right choice when:

- the table is small, or people never go past the first few pages,
- you really need "jump to page N",
- the data doesn't change while people page through it, like a nightly report.

Lots of admin panels use OFFSET and never notice a problem. Cursors start paying off when lists get long, people scroll deep, or the data changes all the time, which is exactly the situation with feeds, logs and public APIs.

## The one-paragraph version

Pagination splits a big list into pages. LIMIT/OFFSET numbers the pages, but the database still has to walk past every skipped row, so deep pages get slower. And because an offset is just a count, inserts and deletes between requests make rows repeat or vanish. Cursor (keyset) pagination remembers the last row returned and asks for rows after it, `WHERE (created_at, id) < (?, ?)`, with a unique tie-breaker and a matching index. That stays fast at any depth and doesn't drift. APIs wrap the cursor in an opaque token: Stripe's `starting_after`, Slack's `next_cursor`, Relay's `after`/`endCursor`. You give up jumping to page N, easy backwards paging and free total counts.

## Where I learned this

These are the pages I read while writing this post. Each claim above comes from one of them, apart from the numbers in "Trying it", which come from running the script on my Pi:

- [PostgreSQL: LIMIT and OFFSET](https://www.postgresql.org/docs/current/queries-limit.html). Skipped rows are still computed, and you need ORDER BY for consistent pages.
- [SQLite: Row Values, section 3.1, scrolling window queries](https://www.sqlite.org/rowvalue.html). How OFFSET is computed, and the row-value pattern for the next page.
- [Use The Index, Luke: No Offset](https://use-the-index-luke.com/no-offset) and [Paging Through Results](https://use-the-index-luke.com/sql/partial-results/fetch-next-page). The seek method, deterministic sort order, the index, and the limits.
- [Stripe API: Pagination](https://docs.stripe.com/api/pagination). `starting_after`, `ending_before`, `has_more`, `limit`.
- [Slack: Pagination](https://docs.slack.dev/apis/web-api/pagination). `next_cursor` and expiring cursors.
- [GraphQL Cursor Connections Specification](https://relay.dev/graphql/connections.htm). Opaque cursors, `first`/`after`, `last`/`before`, `pageInfo`.
