export const sections = {
  integrations: "Integrations",
  tools: "Tools",
  activity: "Activity",
  settings: "Settings",
} as const;

export type Section = keyof typeof sections;
export const defaultSection = "integrations" satisfies Section;
export const fields = ["subject", "body", "tag"] as const;
export type Inputs = Record<(typeof fields)[number], string>;

export const sectionPath = (section: Section) => `/${section}`;
export const integrationPath = (id: string) => `/integration/${encodeURIComponent(id)}`;
export const toolPath = (integration: string, name: string) =>
  `/tool/${encodeURIComponent(integration)}/${encodeURIComponent(name)}`;

export function isSection(value: string): value is Section {
  return Object.hasOwn(sections, value);
}

export function parseLink(value: string) {
  const url = new URL(value);
  if (url.protocol !== "routeprobe:") return;
  const segments = url.pathname.slice(1).split("/").map(decodeURIComponent);
  if (url.hostname === "integration" && segments.length === 1 && segments[0]) {
    return integrationPath(segments[0]);
  }
  if (url.hostname === "tool" && segments.length === 2 && segments[0] && segments[1]) {
    return toolPath(segments[0], segments[1]) + url.search;
  }
}

export function inputsFrom(query: URLSearchParams): Inputs {
  return {
    subject: query.get("subject") ?? "",
    body: query.get("body") ?? "",
    tag: query.get("tag") ?? "",
  };
}

export const exampleIntegration = "sample";
export const exampleTool = "compose";
