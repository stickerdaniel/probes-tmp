import { Schema } from "effect";
import { OpenRpc, Rpc, RpcGroup } from "effect/rpc";

const setting = Schema.Struct({ enabled: Schema.Boolean });
const refusal = Schema.TaggedStruct("SettingRefused", { reason: Schema.String });
const optional = Schema.Struct({ value: Schema.optionalKey(Schema.String) });
const nullable = Schema.Struct({ value: Schema.NullOr(Schema.String) });
const optionalRefusal = Schema.TaggedStruct("OptionalRefused", {
  value: Schema.optionalKey(Schema.String)
});
const nullableRefusal = Schema.TaggedStruct("NullableRefused", {
  value: Schema.NullOr(Schema.String)
});

export const parseOptions = { onExcessProperty: "error" } as const;

export const base = RpcGroup.make(
  Rpc.make("autostart.show", { success: setting, error: refusal })
    .annotate(OpenRpc.Description, "Returns whether the desktop app starts at login."),
  Rpc.make("autostart.set", { payload: setting, success: setting, error: refusal })
    .annotate(OpenRpc.Description, "Makes the desktop app start at login or not, and returns the setting that holds afterwards. A refusal leaves the setting unchanged.")
).annotateRpcs(Rpc.ParseOptions, parseOptions);

export const extended = base.merge(RpcGroup.make(
  Rpc.make("sample.optional", { payload: optional, success: optional, error: optionalRefusal }),
  Rpc.make("sample.nullable", { payload: nullable, success: nullable, error: nullableRefusal })
)).annotateRpcs(Rpc.ParseOptions, parseOptions);
