<script lang="ts">
  import { page } from "$app/state";
  import Tool from "../../../../../shared/Tool.svelte";

  let location = $derived(page.url.pathname + page.url.search);
</script>

{#key location}
  <Tool {location} name={page.params.name} />
{/key}
