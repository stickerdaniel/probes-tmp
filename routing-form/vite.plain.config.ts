import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: "plain",
  plugins: [svelte()],
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
});
