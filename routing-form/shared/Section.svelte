<script lang="ts">
  import { exampleIntegration, exampleTool, integrationPath, sections, toolPath, type Section } from "./destinations";
  let { section }: { section: Section } = $props();
</script>

<h1>{sections[section]}</h1>
{#if section === "integrations"}
  <a href={integrationPath(exampleIntegration)}>Sample integration</a>
{:else if section === "tools"}
  <a href={toolPath(exampleIntegration, exampleTool)}>Compose</a>
{/if}
