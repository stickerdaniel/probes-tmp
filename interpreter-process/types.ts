export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type HostCall = (arg: unknown) => Promise<Json>;
export type HostCalls = { read: HostCall; write: HostCall };
export type Result =
  | { ok: true; value: unknown; logs?: unknown; warnings?: unknown }
  | { ok: false; error: unknown; logs?: unknown; warnings?: unknown };
export type Options = { timeoutMs?: number; memoryBytes?: number; outputBytes?: number };
export type Form = "sync" | "async";
export type Engine = {
  evaluate: (body: string, form?: Form) => Promise<Result>;
  dispose: () => void;
  memoryUsage?: () => unknown;
};
export type Adapter = {
  id: string;
  create: (options?: Options, calls?: HostCalls) => Engine;
  globalNames?: string[];
};
export type Initialize = () => Promise<Adapter>;
