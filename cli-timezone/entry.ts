import { runMain } from "@effect/platform-bun/BunRuntime";
import { layer } from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";

export function launch<E>(program: Effect.Effect<void, E, BunServices>) {
  runMain(Effect.provide(program, layer), { disableErrorReporting: true });
}

export const environment = Effect.sync(() => {
  console.log(JSON.stringify({ dotenv: process.env.PROBE_CWD_VALUE ?? null }));
});
