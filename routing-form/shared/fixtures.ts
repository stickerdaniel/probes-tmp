import { integrationPath, sectionPath, toolPath } from "./destinations";

export const variants = ["normal", "entry-404", "warm-query", "history", "draft"] as const;
export type Variant = (typeof variants)[number];
export const cases = ["cold", "warm", "history", "draft"] as const;
export type Case = (typeof cases)[number];

function toolLink(integration: string, name: string, values: string[]) {
  const search = new URLSearchParams({ subject: values[0], body: values[1], tag: values[2] }).toString();
  const path = toolPath(integration, name) + "?" + search;
  return { path, name, values, url: "routeprobe:/" + path };
}

export const cold = toolLink("sample", "compose", ["First subject", "A+B & C", "冷"]);
export const warm = toolLink("other", "preview", ["Second subject", "A # B", "暖"]);
export const reopened = toolLink("sample", "preview", ["Third subject", "Done?", "終"]);
export const draft = ["Written subject", "Written body", "Written tag"];
export const sectionWalk = [
  [sectionPath("integrations"), "Integrations"],
  [sectionPath("tools"), "Tools"],
  [sectionPath("activity"), "Activity"],
  [sectionPath("settings"), "Settings"],
] as const;
export const detail = integrationPath("sample");
