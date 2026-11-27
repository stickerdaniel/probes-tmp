<script lang="ts">
  import { exampleTool, toolPath } from "./destinations";
  let { id }: { id: string } = $props();
</script>

<h1>{id}</h1>
<a href={toolPath(id, exampleTool)}>Compose</a>
