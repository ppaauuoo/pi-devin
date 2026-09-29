import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";

// pi loads extensions through jiti: TypeScript extensions get transpiled and their
// "@earendil-works/pi-ai/compat" import maps to the bundle's virtual module, while plain .js
// dist extensions (e.g. pi-advisor-flow) are native-imported and resolve the on-disk
// @earendil-works/pi-ai copy — two separate provider registries. Register devin-local into the
// on-disk copy too, resolved relative to this package, so both registries see it.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const devinLocalRequire = createRequire(import.meta.url);
const devinLocalDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const onDiskCompatPath = path.join(devinLocalDir, "..", "@earendil-works", "pi-ai", "dist", "compat.js");
let registerApiProviderOnDisk: typeof registerApiProvider | null = null;
try {
  registerApiProviderOnDisk = devinLocalRequire(onDiskCompatPath).registerApiProvider;
} catch {
  // on-disk copy not present — virtual registration alone is fine
}

function registerDevinCompatEverywhere(provider: Parameters<typeof registerApiProvider>[0]): void {
  registerApiProvider(provider, "pi-devin");
  try {
    registerApiProviderOnDisk?.(provider, "pi-devin");
  } catch {
    // already registered or incompatible — ignore
  }
}
import { authStatus, ensureCredentials, loginWithCli, readCredentials } from "../src/credentials.js";
import { readDevinDesktopApiKey } from "../src/desktop-auth.js";
import { whichDevin, devinVersion } from "../src/cli.js";
import { FALLBACK_MODELS, loadCliCatalog, modelsFromCatalog } from "../src/models.js";
import { CLIENT_IDE, CLIENT_VERSION } from "../src/metadata.js";
import { streamDevin } from "../src/stream.js";

const PROVIDER_ID = "devin";
const PLACEHOLDER_BASE_URL = "https://server.codeium.com";

let _pi: ExtensionAPI | null = null;

function registerDevinProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Devin Local",
    api: "devin-local",
    baseUrl: PLACEHOLDER_BASE_URL,
    models,
    oauth: {
      name: "Devin CLI",
      async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const creds = await loginWithCli();
        if (_pi) {
          try {
            const catalog = await loadCliCatalog();
            registerDevinProvider(_pi, modelsFromCatalog(catalog));
          } catch {
            // keep current models
          }
        }
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        const creds = readCredentials();
        if (!creds) return credentials;
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      getApiKey(credentials: OAuthCredentials): string {
        return readCredentials()?.apiKey || credentials.access;
      },
      modifyModels(models: Model<Api>[], _credentials: OAuthCredentials): Model<Api>[] {
        return models;
      },
    },
    streamSimple: streamDevin,
  });

  // Also register in the global compat api-registry so tools that stream via
  // @earendil-works/pi-ai/compat (e.g. pi-advisor-flow) can use devin models.
  registerDevinCompatEverywhere({ api: "devin-local", stream: streamDevin, streamSimple: streamDevin });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  _pi = pi;
  registerDevinProvider(pi, FALLBACK_MODELS);

  try {
    if (await ensureCredentials()) {
      const catalog = await loadCliCatalog();
      registerDevinProvider(pi, modelsFromCatalog(catalog));
    }
  } catch {
    // fallback models already registered
  }

  pi.registerCommand("devin-status", {
    description: "Show Devin CLI auth + binary status",
    handler: async (_args, ctx) => {
      const bin = await whichDevin();
      const version = await devinVersion();
      const status = await authStatus();
      const creds = readCredentials();
      const desktop = creds ? null : await readDevinDesktopApiKey();
      ctx.ui.notify(
        [
          bin ? `CLI: ${bin}` : "CLI: not found",
          version ? `CLI version: ${version}` : "CLI version: unknown",
          `Client identity: ${CLIENT_IDE} ${CLIENT_VERSION}`,
          creds
            ? `Credentials: ${creds.path}`
            : desktop
              ? `Credentials: none stored yet; Devin Desktop sign-in found at ${desktop.source}`
              : "Credentials: none found (no CLI store, no Devin Desktop sign-in)",
          status.loggedIn ? "Auth: signed in via Devin CLI" : "Auth: not signed in. Run /login devin or `devin auth login`",
        ].join("\n"),
        status.loggedIn && bin ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("devin-refresh", {
    description: "Refresh Devin Local model catalog from `devin models list`",
    handler: async (_args, ctx) => {
      try {
        const catalog = await loadCliCatalog();
        const models = modelsFromCatalog(catalog);
        registerDevinProvider(pi, models);
        ctx.ui.notify(`Devin: loaded ${models.length} families from the local CLI.`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Devin refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    _pi = null;
  });
}
