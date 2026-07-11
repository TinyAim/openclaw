import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  loadConfig,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import type { OpenClawConfig } from "./types.js";

describe("runtime config snapshot writes", () => {
  it("preserves source secret refs when writeConfigFile receives runtime-resolved config", async () => {
    await withTempHome("openclaw-config-runtime-write-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const sourceConfig: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
      };
      const runtimeConfig: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "sk-runtime-resolved",
              models: [],
            },
          },
        },
      };

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf8");

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        expect(loadConfig().models?.providers?.openai?.apiKey).toBe("sk-runtime-resolved");

        await writeConfigFile(loadConfig());

        const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
          models?: { providers?: { openai?: { apiKey?: unknown } } };
        };
        expect(persisted.models?.providers?.openai?.apiKey).toEqual({
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        });
      } finally {
        clearRuntimeConfigSnapshot();
        clearConfigCache();
      }
    });
  });

  it("refreshes the runtime snapshot after config mutations", async () => {
    await withTempHome("openclaw-config-runtime-refresh-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const sourceConfig: OpenClawConfig = {
        agents: {
          list: [{ id: "main" }, { id: "111" }, { id: "112" }],
        },
      };
      const runtimeConfig: OpenClawConfig = {
        agents: {
          list: [{ id: "main" }, { id: "111" }, { id: "112" }],
        },
      };

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf8");

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

        await writeConfigFile({
          agents: {
            list: [{ id: "main" }, { id: "112" }],
          },
        });
        expect(loadConfig().agents?.list?.map((agent) => agent.id)).toEqual([
          "main",
          "112",
        ]);

        await writeConfigFile({
          agents: {
            list: [{ id: "main" }],
          },
        });
        expect(loadConfig().agents?.list?.map((agent) => agent.id)).toEqual([
          "main",
        ]);

        const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        expect(persisted.agents?.list?.map((agent) => agent.id)).toEqual([
          "main",
        ]);
      } finally {
        clearRuntimeConfigSnapshot();
        clearConfigCache();
      }
    });
  });
});
