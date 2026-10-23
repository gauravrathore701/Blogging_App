---
title: "gRPC explained: what actually goes over the wire"
description: "What gRPC is and what goes over the wire: the .proto contract, Protobuf bytes, HTTP/2 framing, deadlines that don't undo work, and the trap that sends every call to one pod."
date: 2026-10-22
category: tech
tags: ["backend-concepts", "distributed-systems", "grpc", "networking"]
draft: false
---

gRPC kept turning up in the last two Backend Concepts posts. In [tail latency](/blog/posts/tail-latency-explained/) it was the library with hedging built in. In [hedged requests](/blog/posts/hedged-requests-explained/) it carried every call in my demo. I'd been using it without explaining what it is, so this post fixes that.

The short version: gRPC is not part of the tail latency problem. It's the *wire* between services, a way for one program to call a function in another. REST over HTTP does the same job. What makes gRPC worth knowing is what it gives you for free: a strict contract, compact messages, streaming, deadlines and cancellation. It also has one trap that catches almost everyone who runs it on Kubernetes.

## The idea: call a function on another machine

The gRPC docs describe it like this: "a client application can directly call a method on a server application on a different machine as if it were a local object."

With REST you think in URLs and JSON: `GET /users/42`, then parse whatever comes back. With gRPC you call `stub.GetUser(id=42)` and get back a typed `User` object. The network is still there, but generated code hides the HTTP request, the encoding and the decoding.

## The contract: a .proto file

Everything starts with a `.proto` file that both sides share. This is the one I used for the demos:

```proto
syntax = "proto3";
package users;

service UserService {
  rpc GetUser (GetUserRequest) returns (User);
  rpc ListUsers (ListUsersRequest) returns (stream User);
}

message GetUserRequest { int64 id = 1; }
message ListUsersRequest { int32 limit = 1; }

message User {
  int64 id = 1;
  string name = 2;
  string email = 3;
  bool active = 4;
}
```

The `service` block lists the methods. The `message` blocks describe the data. The numbers after each field (`= 1`, `= 2`) matter more than the names, as you'll see in a moment.

You then run the compiler, `protoc`, with a gRPC plugin. It generates client and server code in your language. For Python it wrote two files: one for the messages and one for the service. The client half is called a *stub*, and calling a method on it makes the network call.

The contract is the main thing gRPC gives a team. Client and server are generated from the same file, so the shape of every call is written down in one place instead of living in each side's JSON parsing.

## What a message looks like as bytes

gRPC encodes messages with Protocol Buffers ("Protobuf"), a binary format, not text. I encoded the same user both ways on my Pi:

```
User(id=42, name="Ada Lovelace",
     email="ada@example.com", active=true)

protobuf  35 bytes
json      71 bytes
```

The Protobuf version is half the size because it never sends field names. Here are the first bytes:

```
08 2a  12 0c 41 64 61 20 4c 6f 76 65 ...
```

- `08` means "field 1, a number". `2a` is 42, the id.
- `12` means "field 2, a length-prefixed value". `0c` is the length, 12, then the 12 bytes of "Ada Lovelace".

That's why the field numbers matter. The wire only carries `1` and `2`, never `id` or `name`. The Protobuf guide says a field's number "cannot be changed once your message type is in use", and that numbers "should never be reused", because "Reusing a field number makes decoding wire-format messages ambiguous." When you delete a field, you list its number as `reserved` so nobody picks it up again.

The cost is that you can't read it. JSON in a log or in `curl` output makes sense on sight. Protobuf bytes need the `.proto` file to decode.

## What goes over the wire

gRPC runs on HTTP/2. Its protocol document spells out what a call looks like:

- It's a POST to a path made of the service and method: `/users.UserService/GetUser`. The generated code contains exactly that string.
- The content type is `application/grpc`.
- Each message is sent with a 5-byte prefix: 1 byte saying whether it's compressed, then 4 bytes giving its length.
- The result status goes in HTTP *trailers*, at the end of the response. In the spec's words, "Status must be sent in Trailers even if the status code is OK."

For my 35-byte user, that prefix is:

```
00 | 00 00 00 23
 |      └ length: 0x23 = 35 bytes
 └ not compressed
```

To be clear: I built these bytes by hand from the spec. I didn't capture them off the network.

HTTP/2 is what makes the rest possible. A single connection can carry many requests at once, interleaved, and either side can keep a stream open and keep sending.

## Four kinds of call

gRPC supports four shapes of method:

- **Unary:** "the client sends a single request to the server and gets a single response back". This is `GetUser`, and it's what most calls look like.
- **Server streaming:** one request, and the server sends a sequence of messages back. That's `ListUsers` above. On the Pi, `ListUsers(limit=3)` streamed back `user-0`, `user-1` and `user-2` as separate messages.
- **Client streaming:** the client sends a sequence of messages, the server sends one reply. Think of uploading a batch.
- **Bidirectional streaming:** "both sides send a sequence of messages", and "the two streams operate independently". Think of chat, or live updates in both directions.

With plain REST, the last three usually mean reaching for something extra, like WebSockets or server-sent events. With gRPC they're declared in the same `.proto` file.

## Deadlines, and what they don't undo

This is the part that ties back to tail latency.

A *deadline* is how long the client is willing to wait. The deadlines guide has a warning I didn't expect: "By default, gRPC does not set a deadline which means it is possible for a client to end up waiting for a response effectively forever." So you should always set one.

I gave the demo service a handler that takes 2 seconds and saves something at the end. The client called it with a 0.5-second deadline:

```
client: DEADLINE_EXCEEDED after 0.50s
server: [('saved after', False)]
```

The client gave up on time, as it should. But the server kept running, and 1.5 seconds later it still did its "save". The `False` is the server's own check, `context.is_active()`: by then the call was already dead, and the handler finished its work anyway, because nothing told it to stop.

The docs cover both halves of this. The server "should periodically check if the RPC that initiated it has been cancelled", because gRPC won't interrupt your code for you. And when a call is cancelled, "Changes made before a cancellation are not rolled back."

That's why the [hedged requests post](/blog/posts/hedged-requests-explained/) says never hedge a plain write. Cancelling the losing copy saves work only if the server checks for it, and it never undoes a write that already happened.

Deadlines can also flow down a chain of calls. If service A has 200 ms left and calls service B, B can be given the remaining time rather than a fresh budget. The guide says this is on by default in Java and Go, and has to be enabled in some other languages such as C++.

## The trap: every call goes to one pod

This one surprises people, so I reproduced it.

Kubernetes Services normally balance *connections*: each new TCP connection goes to the next pod. That works fine for HTTP/1.1 clients that open many connections. But William Morgan's 2018 Kubernetes blog post explains that gRPC "is built on HTTP/2, and HTTP/2 is designed to have a single long-lived TCP connection, across which all requests are multiplexed." Then: "Once the connection is established, there's no more balancing to be done."

I ran three copies of the service on my Pi, behind a small proxy that round-robins *connections* the way a Kubernetes Service does. Then I sent 300 calls three different ways:

```
how the client connected     server-1/2/3
one channel, via proxy        300 /   0 /   0
new connection per call        10 /  10 /  10
client-side round_robin       101 / 100 /  99
```

With one channel, all 300 calls went to the first server, and the other two did nothing. Opening a new connection per call spread them evenly (I did 30 of those), but it throws away the point of HTTP/2. The real fix is to balance *requests*, not connections. Either the client knows every server and round-robins between them itself (the last line), or a proxy that understands HTTP/2 does it. The Kubernetes post suggests a headless Service, so DNS returns every pod's address to a client that can balance, or a service mesh like Linkerd.

A side finding: my first try at "new connection per call" sent all 30 calls to server 1 anyway. Python's gRPC library shares connections between channels to the same address, so my "new" channels were reusing the old TCP connection. I had to set the `grpc.use_local_subchannel_pool` option to get a fresh one. Connection reuse runs deep in gRPC.

## When to use it, and when not to

gRPC fits best **between your own services**: many small calls, a contract that several teams share, clients in different languages, and streaming. That's where the contract, the compact messages and the built-in deadlines, retries and hedging pay off.

It fits worse at the **edge, facing browsers**. Browsers can't speak native gRPC. The gRPC-Web project says clients "connect to gRPC services via a special proxy" (Envoy by default), and "Client-side and Bi-directional streaming is not currently supported." For a public API that people call with `curl`, JSON over HTTP is still easier to read, debug and cache.

Many systems use both: REST or GraphQL at the edge, gRPC behind it.

## The one-paragraph version

gRPC lets one service call another's methods as if they were local functions. Both sides are generated from a shared `.proto` file, messages are compact Protobuf bytes (35 against 71 for the same user in JSON), and calls run over HTTP/2 with a 5-byte length prefix per message and the status in trailers. It supports streaming in either direction. It has no deadline by default, so set one; and when a call is cancelled, the server keeps working unless it checks, and nothing is rolled back. Because HTTP/2 keeps one long-lived connection, connection-level load balancing sends every call to one server; on my Pi all 300 went to the same one until the client balanced requests itself. Use it between services, and keep JSON at the browser edge.

## Where I learned this

The Pi numbers come from one Python script run on 2026-10-22 (Python 3.13.5, grpcio 1.84.0, protobuf 7.36.2), with three servers on one machine and a hand-written TCP proxy standing in for a Kubernetes Service.

- [gRPC: Introduction](https://grpc.io/docs/what-is-grpc/introduction/). The "local object" definition, Protobuf, and `protoc`.
- [gRPC: Core concepts](https://grpc.io/docs/what-is-grpc/core-concepts/). The four kinds of method, deadlines, and cancellations not rolling back.
- [gRPC: Deadlines guide](https://grpc.io/docs/guides/deadlines/). No deadline by default, propagation by language, and checking for cancellation.
- [Protocol Buffers: proto3 language guide](https://protobuf.dev/programming-guides/proto3/). Field numbers, why they can't be reused, and `reserved`.
- [gRPC over HTTP/2 protocol spec](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md). The path, the content type, the 5-byte prefix and status in trailers.
- [William Morgan, *gRPC Load Balancing on Kubernetes without Tears*, Kubernetes blog, 2018](https://kubernetes.io/blog/2018/11/07/grpc-load-balancing-on-kubernetes-without-tears/). Why connection-level balancing fails, and the fixes.
- [gRPC-Web README](https://github.com/grpc/grpc-web). The browser proxy and the streaming limits.
