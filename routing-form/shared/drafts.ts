import { inputsFrom, type Inputs } from "./destinations";

export const drafts = new Map<string, Inputs>();

export function readDraft(location: string) {
  return { ...inputsFrom(new URLSearchParams(location.split("?")[1])), ...drafts.get(location) };
}
