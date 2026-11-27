<script lang="ts">
  import { page } from "$app/state";
  import Integration from "../../../../shared/Integration.svelte";
</script>

<Integration id={page.params.id} />
