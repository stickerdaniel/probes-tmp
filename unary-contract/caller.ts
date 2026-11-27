import assert from "node:assert/strict";
import { Cause, Effect, Exit, Schedule, Schema } from "effect";
import { Rpc, RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { extended, parseOptions } from "./contract";

import { died, failed, ok, protocolFailure, trials, type Trial } from "./trials";

function checked(protocol: RpcClient.Protocol["Service"]): RpcClient.Protocol["Service"] {
  const checkById = new Map<string, (exit: unknown) => boolean>();
  return {
    ...protocol,
    send(clientId, request, transferables) {
      if (request._tag === "Request") {
        const method = extended.requests.get(request.tag);
        assert.ok(method);
        const accepts = Schema.decodeUnknownExit(protocol.codecFor(Rpc.exitSchema(method)), parseOptions);
        checkById.set(String(request.id), (exit) => Exit.isSuccess(accepts(exit)));
      } else if (request._tag === "Interrupt") {
        checkById.delete(String(request.requestId));
      }
      return protocol.send(clientId, request, transferables);
    },
    run(clientId, deliver) {
      return protocol.run(clientId, (frame) => {
        if (frame._tag !== "Exit") return deliver(frame);
        const id = String(frame.requestId);
        const accepts = checkById.get(id);
        checkById.delete(id);
        if (accepts === undefined || accepts(frame.exit)) return deliver(frame);
        checkById.clear();
        const reason = new RpcClientError.RpcClientDefect({ message: "Invalid method reply", cause: undefined });
        return deliver({ _tag: "ClientProtocolError", error: new RpcClientError.RpcClientError({ reason }) });
      });
    }
  };
}

function outcome(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) return ok(exit.value);
  const first = exit.cause.reasons[0];
  if (Cause.isDieReason(first) && first.defect instanceof Error) {
    return first.defect.name === "SchemaError" ? died : { kind: first.defect.name, message: first.defect.message };
  }
  assert.ok(Cause.isFailReason(first), Cause.pretty(exit.cause));
  const error = first.error;
  if (error instanceof RpcClientError.RpcClientError) return protocolFailure(error.reason._tag);
  return failed(error);
}

async function caller(trial: Trial) {
  const writer = Bun.stdout.writer();
  const writable = new WritableStream<Uint8Array>({
    async write(bytes) {
      writer.write(bytes);
      await writer.flush();
    }
  });
  const result = Effect.gen(function* () {
    const socket = yield* Socket.fromTransformStream(Effect.succeed({ readable: Bun.stdin.stream(), writable }));
    const base = yield* RpcClient.makeProtocolSocket({
      retryPolicy: Schedule.recurs(0),
      pingInterval: "30 seconds"
    }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerNdJsonRpc())
    );
    const client = yield* RpcClient.make(extended, { disableTracing: true, flatten: true })
      .pipe(Effect.provideService(RpcClient.Protocol, trial.checked ? checked(base) : base));
    const order: number[] = [];
    const outcomes = yield* Effect.all(trial.calls.map(([method, params], index) =>
      Effect.suspend(() => client(method, params as never)).pipe(
        Effect.exit,
        Effect.map((exit) => {
          order.push(index);
          return outcome(exit);
        })
      )
    ), { concurrency: "unbounded" });
    return { outcomes, order };
  });
  const completion = await Effect.runPromise(result.pipe(Effect.timeout("10 seconds"), Effect.scoped));
  process.stderr.write(JSON.stringify(completion) + "\n");
}

await caller(trials[Bun.argv[2]]);
