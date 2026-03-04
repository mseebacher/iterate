import { execSync } from "node:child_process";
import { defineConfig, type PluginOption } from "vite";
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { devtools } from "@tanstack/devtools-vite";
import { vitePublicUrl } from "@iterate-com/shared/force-public-url-vite-plugin";
import viteTsConfigPaths from "vite-tsconfig-paths";

/**
 * PostHog source map upload plugin — only active when POSTHOG_PERSONAL_API_KEY
 * and POSTHOG_PROJECT_ID env vars are set (CI deploys). Injects chunk-id metadata
 * into bundled JS so PostHog can match errors to source maps, uploads the .map
 * files, then deletes them so they aren't served publicly.
 */
async function posthogSourcemaps(): Promise<PluginOption[]> {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!apiKey || !projectId) return [];

  const { default: posthog } = await import("@posthog/rollup-plugin");
  return [
    posthog({
      personalApiKey: apiKey,
      envId: projectId,
      host: "https://eu.i.posthog.com",
      sourcemaps: {
        enabled: true,
        releaseName: "iterate-os",
        deleteAfterUpload: true,
      },
    }),
  ];
}

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: {
    sourcemap: true,
    minify: "terser",
    terserOptions: {
      mangle: false,
    },
  },
  server: {
    host: "0.0.0.0",
    cors: false,
    strictPort: false,
    allowedHosts: [
      "host.docker.internal",
      ".iterate.com",
      ".iterate.app",
      ".iterate-dev.com",
      ".iterate-dev.app",
    ],
  },
  plugins: [
    {
      // can't use execSync or fs in miniflare, don't want to put doppler secrets in the env, so we inject in a transform
      name: "runtime-doppler-variable-injector",
      transform(code) {
        const vitePublicEnvVarsFromDoppler = {
          VITE_PUBLIC_DOCKER_DEFAULT_IMAGE: "DOCKER_DEFAULT_IMAGE",
          VITE_PUBLIC_FLY_DEFAULT_IMAGE: "FLY_DEFAULT_IMAGE",
        } satisfies Record<`VITE_PUBLIC_${string}`, string>;
        for (const [viteVar, dopplerVar] of Object.entries(vitePublicEnvVarsFromDoppler)) {
          const viteVarExpression = new RegExp(`import\\.meta\\.env\\.${viteVar}\\b`, "g");
          if (code.match(viteVarExpression)) {
            const command = `doppler secrets get ${dopplerVar} --plain --no-exit-on-missing-secret`;
            const replacement = execSync(command).toString().trim();
            code = code.replaceAll(viteVarExpression, JSON.stringify(replacement));
          }
        }
        return code;
      },
    },
    {
      name: "iterate-os-banner",
      configureServer(server) {
        const _printUrls = server.printUrls;
        server.printUrls = () => {
          server.config.logger.info("\n  iterate os server ready\n");
          _printUrls();
        };
      },
    },
    // @ts-expect-error - version mismatch
    vitePublicUrl(),
    devtools({
      eventBusConfig: {
        // Port 0 enables auto-assigned port (default behavior)
        port: 0,
      },
    }),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    alchemy(),
    tailwindcss(),
    tanstackStart({
      srcDirectory: "./app",
      router: {
        addExtensions: true,
        virtualRouteConfig: "./app/routes.ts",
      },
    }),
    viteReact(),
    posthogSourcemaps(),
  ],
  define: {
    "import.meta.vitest": "undefined",
  },
});
