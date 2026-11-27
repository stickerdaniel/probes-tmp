import assert from "node:assert/strict";
import { JsonSchema, Schema, SchemaRepresentation } from "effect";
import { OpenRpc, Rpc } from "effect/rpc";
import { base, extended, parseOptions } from "./contract";

const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

function documents(group: typeof base | typeof extended) {
  const info = { title: "Shell control", version: "1" };
  const openrpc = OpenRpc.fromRpcGroup(group, { info });
  const methods = [...group.requests.values()];
  const asts = methods.map((method) => {
    const { error, defect } = Rpc.exitSchema(method);
    return Schema.toCodecJson(Schema.Cause(error, defect)).ast;
  });
  const [first, ...rest] = asts;
  assert.ok(first);
  const representations = SchemaRepresentation.toRepresentations([first, ...rest]);
  const draft = SchemaRepresentation.toJsonSchemaMultiDocument(representations, parseOptions);
  const lowered = JsonSchema.toDocumentDraft07({
    dialect: "draft-2020-12",
    schema: { anyOf: [...draft.schemas] },
    definitions: draft.definitions
  });
  assert.ok("anyOf" in lowered.schema && Array.isArray(lowered.schema.anyOf));
  const definitions = { ...lowered.definitions };
  for (const [index, method] of methods.entries()) {
    const name = method._tag.split(".").map((piece) => piece[0].toUpperCase() + piece.slice(1)).join("") + "Cause";
    assert.ok(!Object.hasOwn(definitions, name));
    definitions[name] = lowered.schema.anyOf[index];
  }
  return { openrpc, causes: { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07, definitions } };
}

for (const [prefix, group] of [["control", base], ["extended", extended]] as const) {
  for (const [name, value] of Object.entries(documents(group))) {
    const output = `schema/${prefix}.${name}.json`;
    const bytes = encode(value);
    if (Bun.argv.includes("--check")) {
      assert.equal(bytes, await Bun.file(output).text(), output);
    } else {
      await Bun.write(output, bytes);
    }
  }
}
