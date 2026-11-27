import { createSubscriber } from "svelte/reactivity";

const subscribe = createSubscriber((update) => {
  window.addEventListener("popstate", update);
  window.addEventListener("route-change", update);
  return () => {
    window.removeEventListener("popstate", update);
    window.removeEventListener("route-change", update);
  };
});

export function currentLocation() {
  subscribe();
  return window.location.pathname + window.location.search;
}

export function go(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new Event("route-change"));
}
