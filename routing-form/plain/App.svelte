<script lang="ts">
  import { onMount } from "svelte";
  import Frame from "../shared/Frame.svelte";
  import { exercise } from "../shared/exercise";
  import { currentLocation, go } from "./history";
  import { resolveRoute } from "./routes";

  let location = $derived(currentLocation());
  let route = $derived(resolveRoute(location));
  const navigation = exercise(go);

  onMount(navigation.start);
</script>

<Frame {location} navigate={navigation.navigate}>
  {#key location}
    {@const View = route.component}
    <View {...route.props} />
  {/key}
</Frame>
