<script lang="ts">
  import { page } from "$app/state";
  import Section from "../../../shared/Section.svelte";
  import { defaultSection, isSection } from "../../../shared/destinations";

  let section = $derived(page.params.section && isSection(page.params.section) ? page.params.section : defaultSection);
</script>

<Section {section} />
