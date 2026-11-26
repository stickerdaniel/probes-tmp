import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { environment, launch } from "./entry";

const nested = Schema.Struct({
  server: Schema.Struct({ port: Schema.Int, tags: Schema.Array(Schema.String) }),
}).pipe(Schema.fromJsonString);

const scalar = Command.make("show", { count: Flag.Int("count") }, ({ count }) =>
  Effect.sync(() => console.log(JSON.stringify({ count })))
);

const json = Command.make(
  "decode",
  { config: Flag.String("config").pipe(Flag.withSchema(nested)) },
  ({ config }) => Effect.sync(() => console.log(JSON.stringify(config)))
);

const item = Command.make("item").pipe(Command.withSubcommands([scalar, json]));
const config = Command.make("environment", {}, () => environment);
const root = Command.make("probe").pipe(Command.withSubcommands([item, config]));

launch(Command.run(root, { version: "1.0.0" }));
