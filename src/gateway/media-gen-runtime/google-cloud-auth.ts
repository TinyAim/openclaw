import { GoogleAuth } from "google-auth-library";

export type GoogleCloudAccessTokenProvider = () => Promise<string>;

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Application Default Credentials with refresh delegated to google-auth-library. */
export function createGoogleCloudAccessTokenProvider(): GoogleCloudAccessTokenProvider {
  const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  return async () => {
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
