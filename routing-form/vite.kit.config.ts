import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit({
    adapter: adapter({ pages: "dist", assets: "dist", fallback: "index.html" }),
    files: { appTemplate: "kit/app.html", routes: "kit/routes", params: "kit/params.ts" },
    paths: { relative: false },
  })],
  build: { target: "es2022" },
});
