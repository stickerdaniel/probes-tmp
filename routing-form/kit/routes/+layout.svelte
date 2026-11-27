<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount, type Snippet } from "svelte";
  import Frame from "../../shared/Frame.svelte";
  import { exercise } from "../../shared/exercise";

  let { children }: { children: Snippet } = $props();
  let location = $derived(page.url.pathname + page.url.search);
  const navigation = exercise((path, replaceState) => goto(path, { replaceState }));

  onMount(navigation.start);
</script>

<Frame {location} navigate={navigation.navigate}>
  {@render children()}
</Frame>
