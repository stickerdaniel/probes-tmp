# Packaged route forms

GitHub Actions run 46063150413 measured source commit `5c69dabaab5897094090f8f019ef14a87a655b62`. The same run supplied the bundles for the local macOS exercise.

## Cases

| System | Form | Cold tool | Second instance | Sidebar, history and detail | Draft |
| --- | --- | --- | --- | --- | --- |
| Local macOS 27.2.1 arm64 | Plain Svelte | Pass, 559.8 ms, 3 inputs, 0/3 asset failures, 0 console errors | Pass, 3 inputs, 1 window, second PID exited, OS reopen also passed | Pass, 10 location and view comparisons | Pass, all 3 typed values restored after Back |
| Local macOS 27.2.1 arm64 | SvelteKit | Pass, 443.6 ms, 3 inputs, 0/19 asset failures, 0 console errors | Pass, 3 inputs, 1 window, second PID exited, OS reopen also passed | Pass, 10 location and view comparisons | Pass, all 3 typed values restored after Back |
| GitHub macOS 15 arm64 | Plain Svelte | Pass, 3517.8 ms, 3 inputs, 0/3 asset failures, 0 console errors | Pass, 3 inputs, 1 window, second PID exited, OS reopen also passed | Pass, 10 location and view comparisons | Pass, all 3 typed values restored after Back |
| GitHub macOS 15 arm64 | SvelteKit | Pass, 2050.3 ms, 3 inputs, 0/19 asset failures, 0 console errors | Pass, 3 inputs, 1 window, second PID exited, OS reopen also passed | Pass, 10 location and view comparisons | Pass, all 3 typed values restored after Back |
| GitHub Ubuntu 24.04 x64 | Plain Svelte | Pass, 2755.2 ms, 3 inputs, 0/3 asset failures, 0 console errors | Pass, 3 inputs, 1 window, second PID exited | Pass, 10 location and view comparisons | Pass, all 3 typed values restored after Back |
| GitHub Ubuntu 24.04 x64 | SvelteKit | Pass, 1050.4 ms, 3 inputs, 0/18 asset failures, 0 console errors | Pass, 3 inputs, 1 window, second PID exited | Pass, 10 location and view comparisons | Pass, all 3 typed values restored after Back |
| GitHub Windows Server 2025 x64 | Plain Svelte | Pass, 18454.4 ms, 3 inputs, 0/5 asset failures, 0 console errors | Pass, 3 inputs, 1 window, second PID exited | Pass, 10 location and view comparisons | Pass, all 3 typed values restored after Back |
| GitHub Windows Server 2025 x64 | SvelteKit | Pass, 6493.1 ms, 3 inputs, 0/20 asset failures, 0 console errors | Pass, 3 inputs, 1 window, second PID exited | Pass, 10 location and view comparisons | Pass, all 3 typed values restored after Back |

The cold link supplied a space, URL punctuation and a non-ASCII tag. The second link supplied three different values and a different tool. The history exercise clicked Integrations, Tools, Activity and Settings. It traversed two entries Back and two Forward. It then visited the integration detail. The draft exercise typed three values, visited Settings and went Back.

## Failure variants

| System | Form | Entry 404 | Dropped warm query | Replaced history entry | Cleared draft |
| --- | --- | --- | --- | --- | --- |
| Local macOS 27.2.1 arm64 | Plain Svelte | Detected | Detected | Detected | Detected |
| Local macOS 27.2.1 arm64 | SvelteKit | Detected | Detected | Detected | Detected |
| GitHub macOS 15 arm64 | Plain Svelte | Detected | Detected | Detected | Detected |
| GitHub macOS 15 arm64 | SvelteKit | Detected | Detected | Detected | Detected |
| GitHub Ubuntu 24.04 x64 | Plain Svelte | Detected | Detected | Detected | Detected |
| GitHub Ubuntu 24.04 x64 | SvelteKit | Detected | Detected | Detected | Detected |
| GitHub Windows Server 2025 x64 | Plain Svelte | Detected | Detected | Detected | Detected |
| GitHub Windows Server 2025 x64 | SvelteKit | Detected | Detected | Detected | Detected |

The first variant returned 404 for the entry document. The second dropped the query from the forwarded link. The third replaced the Tools entry on the move to Activity, so the second Back operation returned to Integrations. The fourth cleared the draft store on leaving for Settings. The driver checked each faulty observation and its corresponding failed row.

## Sizes

| System | Form | Package bytes | Interface bytes |
| --- | --- | ---: | ---: |
| Local macOS 27.2.1 arm64 | Plain Svelte | 11,696,401 | 47,128 |
| Local macOS 27.2.1 arm64 | SvelteKit | 11,729,425 | 102,940 |
| GitHub macOS 15 arm64 | Plain Svelte | 11,696,401 | 47,128 |
| GitHub macOS 15 arm64 | SvelteKit | 11,729,425 | 102,940 |
| GitHub Ubuntu 24.04 x64 | Plain Svelte | 4,200,020 | 47,128 |
| GitHub Ubuntu 24.04 x64 | SvelteKit | 4,221,996 | 102,940 |
| GitHub Windows Server 2025 x64 | Plain Svelte | 1,995,187 | 47,137 |
| GitHub Windows Server 2025 x64 | SvelteKit | 2,015,646 | 102,952 |

## Build and measurement

The JavaScript pins are Bun 1.4.3, Node 24.22.2 on the runners, Svelte 5.57.3, Vite 8.3.8 and the Svelte Vite plugin 7.3.2. SvelteKit uses 3.4.0 with adapter-static 4.0.1. SvelteKit 3.4.1 was less than 72 hours old at the version check.

The native pins are Rust 1.99.1, Tauri 2.12.7, tauri-build 2.7.6, the Tauri CLI 2.12.6, the JavaScript API 2.12.5, deep-link 2.6.3 and single-instance 2.5.5. Both plugins declare Tauri 2.12 compatibility. Bun uses `--frozen-lockfile --ignore-scripts`. Cargo uses `--locked`.

Both native packages start a hidden window at the embedded `index.html`. SvelteKit uses `index.html` as the static fallback and absolute asset paths. It packages the client output without a server. The Linux desktop entry passes the URL with `%u`. The Linux exercise runs in a D-Bus session under Xvfb. The Windows exercise installs the NSIS package for the current user.

The system opener sends the cold and warm links. On macOS, LaunchServices normally sends a warm URL to the existing process. The driver also uses `open -g -n` with a new link as an argument to observe a real second PID and its exit. On Linux and Windows, the opener starts the second process with the URL as its argument.

The cold timer starts at Rust `main` and stops when the native harness receives a measurement after two animation frames in the visible WebView. The timer includes the frame and IPC delay and excludes the executable loader. The cold samples are single launches on each environment. The asset counts include requests recorded by the native response hook up to that measurement. The initialization script records resource and console errors, including module load errors. The negative entry response has no body and produces no painted destination.

Plain Svelte uses 65 nonblank routing lines across its map, history adapter, mount, app and Vite config. SvelteKit uses 50 across its page wrappers, layout, parameter matcher and Vite config. The counts include entry wiring and exclude the HTML skeleton, common views, link parsing, drafts and test automation. The package counts are bytes on disk for the DEB and NSIS installer and bytes summed across the macOS app files. The interface counts sum the files in `dist`.

## Location state

Paths are relative to this directory. The URL is the navigation input in both forms. The browser stores the current URL and previous and forward history entries. The rendered URL and its matching route parameters are derived from the current entry.

| Case | Shared state | Plain Svelte | SvelteKit |
| --- | --- | --- | --- |
| Cold link | The deep-link plugin retains its last URL. `Probe.pending` queues a link before the listener exists (`src-tauri/src/main.rs:25,41,54,96`). The bridge takes `links`, parses each `link` and hands its `path` to navigation (`shared/exercise.ts:122-138`, `shared/destinations.ts:22-32`). | `window.location.pathname/search` supplies `location`. `route` derives the component and its parameters (`plain/history.ts:12-19`, `plain/App.svelte:8-9`, `plain/routes.ts:10-22`). The cold link replaces the root history entry. | Kit commits its `page.url`, `page.params` and route id through `goto`. The layout and tool page derive their `location` from `page.url`. The tool reads `page.params.name` (`kit/routes/+layout.svelte:9-10`, `kit/routes/tool/[integration]/[name]/+page.svelte:5-9`). |
| Warm link | The same queue carries the new path and query. The queue can refer to the next destination while the window still shows the current one. | The same URL and derived route apply. The new link pushes a history entry. The previous URL remains in history. | The same Kit page state applies. The new link pushes a history entry. The previous URL remains in history. |
| Sidebar and history | The anchor carries the requested path in `href`. `path` is temporary. `Frame.location` sets `aria-current` and `main.dataset.location` from the route prop (`shared/Frame.svelte:6,17,27,30`). The harness compares the DOM location, browser location and heading (`shared/exercise.ts:18-29,75-93`). | `go` calls the browser History API. `route-change` and `popstate` invalidate the subscriber (`plain/history.ts:3-20`). The table derives the section, integration id or tool name from the current pathname. | Kit handles `popstate`. The section page derives `section` from `page.params.section`. The integration page reads `page.params.id` (`kit/routes/[[section=section]]/+page.svelte:6`, `kit/routes/integration/[id]/+page.svelte:6`). |
| Draft return | `Tool.location` and `Tool.name` come from the active route. `drafts` maps the URL to its three input values. `inputs` holds the current form edit and starts from the matching URL query and draft entry (`shared/Tool.svelte:5-10`, `shared/drafts.ts:3-6`). A stored draft key can name an inactive route. | The keyed view remounts from the restored location (`plain/App.svelte:16-19`). | The keyed tool page remounts from the restored location (`kit/routes/tool/[integration]/[name]/+page.svelte:8-10`). |

Plain Svelte has a derived URL and a derived route. A route transition can change the browser URL before the Svelte render flushes. The installed subscriber covers browser history traversal and the writes through `go`. An independent call to `history.pushState` would bypass the subscriber.

SvelteKit 3.4.0 holds the active navigation in `current.url` and `current.nav` (`src/runtime/client/client.js:331,2166` in the dependency). It exposes `internal_page.url`, `params` and `route` through `page` (`src/runtime/app/state/client.svelte.js:9-25,65`). Pending navigation exposes `navigating.from` and `navigating.to` (line 110). Kit stores history and navigation indices in the history entry (`src/runtime/client/client.js:2120-2133`). A history traversal can update the browser URL before Kit commits the next page. Kit tracks the browser entry during that transition (lines 3329-3347). The probe uses regular navigation. The branch that stores `pageUrl` for shallow navigation is outside the measured cases (line 2937).

The probe has separate fixture expectations in `shared/fixtures.ts:11-24`. These paths, the observations in `shared/exercise.ts:21-22,76,100,127` and the driver result rows do not set the active page.
