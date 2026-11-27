import SectionView from "../shared/Section.svelte";
import Integration from "../shared/Integration.svelte";
import Tool from "../shared/Tool.svelte";
import { defaultSection, isSection } from "../shared/destinations";

function entry<Props extends Record<string, unknown>>(path: RegExp, component: import("svelte").Component<Props>, props: (match: RegExpExecArray, location: string) => Props) {
  return { path, resolve: (match: RegExpExecArray, location: string) => ({ component, props: props(match, location) }) };
}

const routes = [
  entry(/^\/([^/]+)$/, SectionView, ([, section]) => ({ section: isSection(section) ? section : defaultSection })),
  entry(/^\/integration\/([^/]+)$/, Integration, ([, id]) => ({ id: decodeURIComponent(id) })),
  entry(/^\/tool\/([^/]+)\/([^/]+)$/, Tool, ([, , name], location) => ({ name: decodeURIComponent(name), location })),
];

export function resolveRoute(location: string) {
  const pathname = location.split("?")[0];
  for (const route of routes) {
    const match = route.path.exec(pathname);
    if (match) return route.resolve(match, location);
  }
  return { component: SectionView, props: { section: defaultSection } };
}
