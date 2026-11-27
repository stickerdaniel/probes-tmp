<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { sections, sectionPath, type Section } from "./destinations";
  import type { Navigate } from "./exercise";

  let { location, navigate, children }: { location: string; navigate: Navigate; children: Snippet } = $props();
  const entries = Object.entries(sections) as [Section, string][];

  onMount(() => {
    window.addEventListener("click", follow, true);
    return () => window.removeEventListener("click", follow, true);
  });

  function follow(event: MouseEvent) {
    if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    const path = link?.getAttribute("href");
    if (!path?.startsWith("/")) return;
    event.preventDefault();
    void navigate(path);
  }
</script>

<div class="shell">
  <nav aria-label="Sections">
    {#each entries as [section, label]}
      <a href={sectionPath(section)} aria-current={sectionPath(section) === location ? "page" : undefined}>{label}</a>
    {/each}
  </nav>
  <main data-location={location}>
    {@render children()}
  </main>
</div>

<style>
  :global(body) { margin: 0; font: 16px system-ui; }
  .shell { display: grid; grid-template-columns: 10rem 1fr; min-height: 100vh; }
  nav, main { padding: 1.25rem; }
  nav { background: #f0f2f4; }
  nav a { display: block; margin-bottom: .75rem; }
  nav a[aria-current] { font-weight: 700; }
  main :global(label) { display: block; margin-bottom: .75rem; }
</style>
