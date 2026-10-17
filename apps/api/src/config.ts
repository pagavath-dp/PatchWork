export type AppConfig = {
  appOrigin: string;
  callbackUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  secureCookies: boolean;
  githubApp?: {
    appId: string;
    clientId: string;
    clientSecret: string;
    privateKeyPath: string;
    slug: string;
    callbackUrl: string;
  };
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = ["APP_ORIGIN", "GITHUB_OAUTH_CALLBACK_URL", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"] as const;
  for (const key of required) {
    if (!env[key] || env[key]?.startsWith("replace-with-")) throw new Error(`Missing configuration: ${key}`);
  }
  const appOrigin = new URL(env.APP_ORIGIN!).origin;
  const callbackUrl = new URL(env.GITHUB_OAUTH_CALLBACK_URL!).toString();
  if (new URL(callbackUrl).origin !== appOrigin) throw new Error("OAuth callback must use APP_ORIGIN");
  return {
    appOrigin,
    callbackUrl,
    githubClientId: env.GITHUB_OAUTH_CLIENT_ID!,
    githubClientSecret: env.GITHUB_OAUTH_CLIENT_SECRET!,
    secureCookies: appOrigin.startsWith("https://"),
    githubApp: ["GITHUB_APP_ID", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY_PATH", "GITHUB_APP_SLUG"].every((key) => Boolean(env[key]) && !env[key]?.startsWith("replace-with-")) ? {
      appId: env.GITHUB_APP_ID!, clientId: env.GITHUB_APP_CLIENT_ID!, clientSecret: env.GITHUB_APP_CLIENT_SECRET!,
      privateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH!, slug: env.GITHUB_APP_SLUG!,
      callbackUrl: `${appOrigin}/auth/github-app/callback`,
    } : undefined,
  };
}
