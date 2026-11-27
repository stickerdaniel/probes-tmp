export const backends = ["serde-json", "core-native", "core-rewrite"] as const;
export type Backend = typeof backends[number];

export const ok = (value: unknown) => ({ kind: "Success", value });
export const died = { kind: "SchemaError" };
export const failed = (value: unknown) => ({ kind: "Failure", value });
export const protocolFailure = (reason: string) => ({ kind: "ProtocolError", reason });

const invalidArgument = { kind: "Error", message: "Schema validation failed" };
const setting = { _tag: "SettingRefused", reason: "locked" };
const protocol = protocolFailure("RpcClientDefect");

export type Call = readonly [method: "autostart.show" | "autostart.set" | "sample.optional" | "sample.nullable", params: unknown];
type Options = {
  refuse?: boolean;
  plain?: boolean;
  loss?: boolean;
  reverse?: boolean;
  dropLast?: boolean;
  replaceParams?: Record<string, unknown>;
  replaceFirstReply?: object;
};

export type Trial = Options & {
  row: 1 | 2 | 3 | 4 | 5 | 6;
  calls: ReadonlyArray<Call>;
  expected: ReadonlyArray<unknown>;
  order?: ReadonlyArray<number>;
  checked?: boolean;
  requests?: number;
  fault?: Options;
  requireMarker?: boolean;
  rejectsParams?: boolean;
};

const set = ["autostart.set", { enabled: true }] as const;
const show = ["autostart.show", undefined] as const;
const optional = (value: unknown): Call => ["sample.optional", value];
const nullable = (value: unknown): Call => ["sample.nullable", value];
const pair = [set, show];

export function markedRefusal(error: object) {
  const data = [{ _tag: "Fail", error }];
  return { error: { _tag: "Cause", code: 0, message: JSON.stringify(data), data } };
}

export const trials: Readonly<Record<string, Trial>> = {
  success: {
    row: 1,
    calls: [show, set, optional({ value: "set" }), nullable({ value: "set" })],
    expected: [ok({ enabled: false }), ok({ enabled: true }), ok({ value: "set" }), ok({ value: "set" })],
    fault: { replaceFirstReply: { result: { enabled: true } } }
  },
  "marked-refusal": {
    row: 2, calls: [set], expected: [failed(setting)], refuse: true, requireMarker: true,
    fault: { plain: true }
  },
  "plain-refusal": { row: 2, calls: [set], expected: [died], refuse: true, plain: true },
  "optional-absent": {
    row: 3, calls: [optional({})], expected: [ok({})],
    fault: { replaceFirstReply: { result: { value: null } } }
  },
  "optional-absent-error": {
    row: 3, calls: [optional({})], expected: [failed({ _tag: "OptionalRefused" })], refuse: true, requireMarker: true
  },
  "optional-present-error": {
    row: 3, calls: [optional({ value: "set" })], expected: [failed({ _tag: "OptionalRefused", value: "set" })],
    refuse: true, requireMarker: true
  },
  "optional-null-argument": {
    row: 3, calls: [optional({ value: null })], requests: 0, expected: [invalidArgument]
  },
  "optional-null-wire": {
    row: 3, calls: [optional({})], expected: [died], replaceParams: { value: null }, rejectsParams: true
  },
  "optional-null-result": {
    row: 3, calls: [optional({})], expected: [died], replaceFirstReply: { result: { value: null } }
  },
  "optional-null-error": {
    row: 3, calls: [optional({})], expected: [died], refuse: true,
    replaceFirstReply: markedRefusal({ _tag: "OptionalRefused", value: null })
  },
  "nullable-null": {
    row: 3, calls: [nullable({ value: null })], expected: [ok({ value: null })]
  },
  "nullable-null-error": {
    row: 3, calls: [nullable({ value: null })], expected: [failed({ _tag: "NullableRefused", value: null })],
    refuse: true, requireMarker: true
  },
  "nullable-present-error": {
    row: 3, calls: [nullable({ value: "set" })], expected: [failed({ _tag: "NullableRefused", value: "set" })],
    refuse: true, requireMarker: true
  },
  "nullable-absent-argument": {
    row: 3, calls: [nullable({})], requests: 0, expected: [invalidArgument]
  },
  "nullable-absent-wire": {
    row: 3, calls: [nullable({ value: null })], expected: [died], replaceParams: {}, rejectsParams: true
  },
  "nullable-absent-result": {
    row: 3, calls: [nullable({ value: null })], expected: [died], replaceFirstReply: { result: {} }
  },
  "nullable-absent-error": {
    row: 3, calls: [nullable({ value: null })], expected: [died], refuse: true,
    replaceFirstReply: markedRefusal({ _tag: "NullableRefused" })
  },
  reverse: {
    row: 4, calls: pair, expected: [ok({ enabled: true }), ok({ enabled: false })], order: [1, 0],
    reverse: true, fault: { reverse: false }
  },
  loss: {
    row: 5, calls: [set], expected: [protocolFailure("SocketCloseError")], loss: true,
    fault: { loss: false }
  },
  "extra-field": {
    row: 6, calls: pair, expected: [died, ok({ enabled: false })],
    replaceFirstReply: { result: { enabled: true, extra: 1 } }
  },
  "extra-field-checked": {
    row: 6, calls: pair, expected: [protocol, protocol], checked: true, dropLast: true,
    replaceFirstReply: { result: { enabled: true, extra: 1 } },
    fault: { dropLast: false, replaceFirstReply: { result: { enabled: true } } }
  },
  "wrong-type": {
    row: 6, calls: pair, expected: [died, ok({ enabled: false })], replaceFirstReply: { result: { enabled: "true" } }
  },
  "wrong-type-checked": {
    row: 6, calls: pair, expected: [protocol, protocol], checked: true, dropLast: true,
    replaceFirstReply: { result: { enabled: "true" } }
  }
};

export function faultFor(name: string, backend: Backend, trial: Trial): Options | undefined {
  if (name === "marked-refusal" && backend === "core-native") {
    return { replaceFirstReply: markedRefusal(setting) };
  }
  return trial.fault;
}
