import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tick } from "svelte";
import { drafts } from "./drafts";
import { fields, parseLink } from "./destinations";
import { cold, detail, draft, reopened, sectionWalk, warm, type Case, type Variant } from "./fixtures";

export type Navigate = (path: string, replace?: boolean) => void | Promise<void>;
type Settings = { variant: Variant; mac: boolean };
type Observation = ReturnType<typeof observe>;

declare global {
  interface Window {
    probeErrors: string[];
  }
}

function observe() {
  const main = document.querySelector("main");
  return {
    location: main?.dataset.location,
    browser: window.location.pathname + window.location.search,
    heading: main?.querySelector("h1")?.textContent,
    inputs: fields.map((field) => main?.querySelector<HTMLInputElement>(`input[name="${field}"]`)?.value),
  };
}

function matches(row: Observation, path: string, heading: string, values?: string[]) {
  return row.location === path && row.browser === path && row.heading === heading &&
    (!values || values.every((value, index) => row.inputs[index] === value));
}

async function rendered(path: string, heading: string, values?: string[]) {
  await tick();
  if (matches(observe(), path, heading, values)) return observe();

  return await new Promise<Observation>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const row = observe();
      if (!matches(row, path, heading, values)) return;
      observer.disconnect();
      clearTimeout(deadline);
      resolve(row);
    });
    const deadline = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Expected ${path} and ${heading}. Observed ${JSON.stringify(observe())}`));
    }, 5000);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

function click(path: string) {
  const target = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.getAttribute("href") === path);
  if (!target) throw new Error(`No link to ${path}`);
  target.click();
}

function painted() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

async function report(test: Case, status: "pass" | "fail", evidence: object, kind = "row") {
  await invoke("record", { row: { kind, case: test, status, ...evidence, errors: window.probeErrors } });
}

export function exercise(go: Navigate) {
  let variant: Variant = "normal";

  const navigate: Navigate = (path, replace) => {
    if (variant === "draft" && path === "/settings") drafts.clear();
    return go(path, replace || (variant === "history" && path === "/activity"));
  };

  async function walk() {
    const observations: Observation[] = [];
    for (const [path, heading] of sectionWalk) {
      click(path);
      observations.push(await rendered(path, heading));
    }
    history.back();
    observations.push(await rendered(...sectionWalk[2]));
    history.back();
    observations.push(await rendered(...sectionWalk[1]));
    history.forward();
    observations.push(await rendered(...sectionWalk[2]));
    history.forward();
    observations.push(await rendered(...sectionWalk[3]));
    click("/integrations");
    observations.push(await rendered(...sectionWalk[0]));
    click(detail);
    observations.push(await rendered(detail, "sample"));
    return observations;
  }

  async function preserveDraft() {
    const [path, heading] = sectionWalk[1];
    click(path);
    await rendered(path, heading);
    const tool = cold.path.split("?")[0];
    click(tool);
    await rendered(tool, cold.name);
    fields.forEach((field, index) => {
      const input = document.querySelector<HTMLInputElement>(`input[name="${field}"]`)!;
      input.value = draft[index];
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const written = await rendered(tool, cold.name, draft);
    click("/settings");
    await rendered(...sectionWalk[3]);
    history.back();
    return [written, await rendered(tool, cold.name, draft)];
  }

  async function run() {
    const settings = await invoke<Settings>("settings");
    variant = settings.variant;
    let handled = 0;
    let draining = Promise.resolve();
    const drain = () => {
      draining = draining.then(async () => {
        const links = await invoke<string[]>("take_links");
        for (const link of links) {
          const path = parseLink(link);
          if (!path) continue;
          const index = handled++;
          const expected = [cold, warm, reopened][index];
          const test = index === 0 ? "cold" : "warm";
          const secondInstance = index === (settings.mac ? 2 : 1);
          const kind = settings.mac && index === 1 ? "system-link" : "row";
          try {
            await navigate(secondInstance && variant === "warm-query" ? path.split("?")[0] : path, index === 0);
            if (index === 0) {
              await tick();
              await invoke("show_window");
            }
            if (!expected) continue;
            const observation = await rendered(expected.path, expected.name, expected.values);
            await painted();
            if (window.probeErrors.length) throw new Error(window.probeErrors.join("\n"));
            await report(test, "pass", { observation, link: index }, kind);
          } catch (error) {
            await report(test, "fail", { observation: observe(), link: index, reason: String(error) }, kind);
            return;
          }
          if (secondInstance && variant !== "warm-query") {
            if (variant !== "draft") {
              try {
                await report("history", "pass", { observations: await walk() });
              } catch (error) {
                await report("history", "fail", { observation: observe(), reason: String(error) });
                return;
              }
            }
            try {
              await report("draft", "pass", { observations: await preserveDraft() });
            } catch (error) {
              await report("draft", "fail", { observation: observe(), reason: String(error) });
            }
          }
        }
      }).catch((error) => report("cold", "fail", { reason: String(error) }));
    };
    await listen("routeprobe-link", drain);
    drain();
  }

  return { navigate, start: () => { void run(); } };
}
