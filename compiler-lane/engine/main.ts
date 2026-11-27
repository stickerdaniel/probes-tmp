import { Context, Effect, Layer } from "effect";

class Input extends Context.Service<Input, { readonly value: number }>()("Input") {}
class Output extends Context.Service<Output, { readonly value: number }>()("Output") {}

const input = Layer.succeed(Input, { value: Bun.argv.length });
const output = Layer.effect(Output, Effect.map(Input, ({ value }) => ({ value })));
const services = output.pipe(Layer.provide(input));

export const read = () => {
  const count: number = Bun.argv.length;
  return Effect.runPromise(Output.pipe(Effect.provide(services), Effect.map(({ value }) => count + value)));
};
