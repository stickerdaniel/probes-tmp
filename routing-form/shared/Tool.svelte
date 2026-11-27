<script lang="ts">
  import { untrack } from "svelte";
  import { fields } from "./destinations";
  import { drafts, readDraft } from "./drafts";
  let { location, name }: { location: string; name: string } = $props();
  let inputs = $state(untrack(() => readDraft(location)));

  function save(field: (typeof fields)[number], value: string) {
    inputs[field] = value;
    drafts.set(location, { ...inputs });
  }
</script>

<h1>{name}</h1>
<form onsubmit={(event) => event.preventDefault()}>
  {#each fields as field}
    <label>
      {field}
      <input name={field} value={inputs[field]} oninput={(event) => save(field, event.currentTarget.value)} />
    </label>
  {/each}
</form>
