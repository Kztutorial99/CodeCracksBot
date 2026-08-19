// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // On Vercel (VERCEL=1 during their build) emit a Vercel-native build.
  // Locally / on Lovable it keeps the default Cloudflare target.
  // maxDuration: sandbox commands and package installs need more than the default limit.
  ...(process.env["VERCEL"]
    ? ({ nitro: { preset: "vercel", vercel: { functions: { maxDuration: 300 } } } } as unknown as Record<
        string,
        unknown
      >)
    : {}),
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
