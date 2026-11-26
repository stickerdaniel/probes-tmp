import { run } from "./rows";

await run(async () => ({
  id: "baseline",
  create() {
    return {
      evaluate: async () => ({ ok: true, value: 1 + 1 }),
      dispose: () => {},
    };
  },
}), import.meta.url, "baseline");
