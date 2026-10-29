import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type GoogleCloudAccessTokenProvider = () => Promise<string>;

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

type GoogleAuthLibrary = {
  GoogleAuth: new (opts: { scopes: string[] }) => {
    getClient(): Promise<{
      getAccessToken(): Promise<string | { token?: string | null } | null>;
    }>;
  };
};

function findOpenClawRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const name = JSON.parse(fs.readFileSync(pkgPath, "utf8")).name;
        if (name === "openclaw") {
          return dir;
        }
      } catch {
        // Keep walking; bundled files can sit beside unrelated package.json.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return process.cwd();
}

function loadGoogleAuthLibrary(): GoogleAuthLibrary {
  const pkg = path.join(findOpenClawRoot(), "extensions/google/package.json");
  if (!fs.existsSync(pkg)) {
    throw new Error(
      `google-auth-library is not available (${pkg} missing); Vertex/Veo ADC is unavailable`,
    );
  }
  return createRequire(pkg)("google-auth-library") as GoogleAuthLibrary;
}

/** Application Default Credentials with refresh delegated to google-auth-library. */
export function createGoogleCloudAccessTokenProvider(): GoogleCloudAccessTokenProvider {
  return async () => {
    const { GoogleAuth } = loadGoogleAuthLibrary();
    const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
    const client = await auth.getClient();
    const access = await client.getAccessToken();
    const token = typeof access === "string" ? access : access?.token;
    if (!token) {
      throw new Error("Google Cloud Application Default Credentials returned no access token");
    }
    return token;
  };
}

export const GOOGLE_CLOUD_PLATFORM_SCOPE = CLOUD_PLATFORM_SCOPE;
