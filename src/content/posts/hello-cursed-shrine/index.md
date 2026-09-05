---
title: "Why this blog runs on a Raspberry Pi"
description: "A static blog, a home server, and an honest look at what that trade buys and costs."
date: 2026-09-02
category: tech
tags: ["raspberry-pi", "astro", "self-hosting"]
draft: false
---

This site is built with Astro, compiled to plain HTML, and served
from a Raspberry Pi 5 sitting behind a Cloudflare tunnel.

## Why static

The Pi has no UPS. On 2026-09-01 it hard-reset in the middle of the
afternoon, almost certainly a mains cut, and nobody was near it.

A server-rendered site would have returned 502 for the duration.
Static HTML sits in Cloudflare's cache and keeps serving.

## What it costs

Every post needs a rebuild and a deploy. There is no publish button
and no browser editor. For a single author writing in Markdown that
is a fair trade.
