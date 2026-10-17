import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./http.js";
import { codeChallenge } from "./oauth.js";

type GitHubAppConfig = NonNullable<AppConfig["githubApp"]>;
const githubId = z.number().int().positive().safe();
const account = z.object({ login: z.string().min(1).max(100) });
const dateTime = z.iso.datetime({ offset: true });
const githubWebUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname === "github.com";
});
const repositorySchema = z.object({ id: githubId, name: z.string().min(1).max(100),
  full_name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  html_url: githubWebUrl, description: z.string().nullable(), default_branch: z.string().min(1).max(255),
  private: z.boolean(), owner: account });
const issueSchema = z.object({ id: githubId, number: z.number().int().positive(), title: z.string(), state: z.string().min(1).max(30),
  html_url: githubWebUrl, user: account.nullable(), created_at: dateTime, updated_at: dateTime,
  pull_request: z.object({}).optional() });
const pullSchema = issueSchema.extend({ draft: z.boolean(), merged_at: dateTime.nullable() });
const eventSchema = z.object({ id: githubId, event: z.string().min(1).max(80), created_at: dateTime,
  actor: account.nullable(), issue: z.object({ number: z.number().int().positive(), title: z.string(), html_url: githubWebUrl }).nullish() });
export type Repository = z.infer<typeof repositorySchema>;
export type GitHubIssue = z.infer<typeof issueSchema>;
export type GitHubPull = z.infer<typeof pullSchema>;
export type GitHubEvent = z.infer<typeof eventSchema>;
export type RepositorySnapshot = { repository: Repository; issues: GitHubIssue[]; pulls: GitHubPull[]; events: GitHubEvent[] };

export interface GitHubGateway {
  authorizationUrl(state: string, verifier: string): string;
  exchangeCode(code: string, verifier: string): Promise<string>;
  verifyUserRepository(token: string, expectedUserId: string, fullName: string): Promise<{ installationId: string; repositoryId: string }>;
  fetchSnapshot(installationId: string, repositoryId: string, fullName: string): Promise<RepositorySnapshot>;
}

export function requireGitHubApp(config: AppConfig): GitHubAppConfig {
  if (!config.githubApp) throw new HttpError(503, "GITHUB_NOT_CONFIGURED", "GitHub repository integration is not configured");
  return config.githubApp;
}

function retryGuidance(response: Response): string {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
    if (Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86_400) {
      return `Wait at least ${seconds} seconds before trying again.`;
    }
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const secondsUntilReset = Math.ceil(reset - Date.now() / 1000);
  if (Number.isSafeInteger(secondsUntilReset) && secondsUntilReset > 0 && secondsUntilReset <= 86_400) {
    return `Wait at least ${secondsUntilReset} seconds before trying again.`;
  }
  return "Wait a few minutes before trying again.";
}

async function githubError(response: Response): Promise<HttpError> {
  let message = "";
  if (response.status === 403) {
    try {
      const body = await response.json() as unknown;
      if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
        message = body.message;
      }
    } catch { /* GitHub can return a non-JSON error body. */ }
  }
  const limited = response.status === 429 || (response.status === 403 && (
    response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after") ||
    /secondary rate limit|abuse detection|too many requests/i.test(message)));
  if (limited) return new HttpError(503, "GITHUB_RATE_LIMITED", `GitHub API rate limit reached. ${retryGuidance(response)}`);
  if (response.status === 401) return new HttpError(502, "GITHUB_ACCESS_REVOKED", "GitHub authorization is no longer valid");
  if (response.status === 403 || response.status === 404) return new HttpError(403, "GITHUB_PERMISSION_DENIED", "GitHub App cannot access this repository");
  return new HttpError(502, "GITHUB_UNAVAILABLE", "GitHub API is unavailable");
}

async function githubFetch(url: string, token: string, options?: RequestInit): Promise<{ data: unknown; headers: Headers }> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options, signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28", ...options?.headers },
    });
  } catch {
    throw new HttpError(502, "GITHUB_UNAVAILABLE", "GitHub API is unavailable");
  }
  if (!response.ok) throw await githubError(response);
  try { return { data: await response.json() as unknown, headers: response.headers }; }
  catch { throw new HttpError(502, "GITHUB_INVALID_RESPONSE", "GitHub returned an invalid response"); }
}

function parseGitHub<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(502, "GITHUB_INVALID_RESPONSE", "GitHub returned invalid data");
  return result.data;
}

const MAX_PAGES = 20;
export async function fetchGitHubPages<T>(url: string, token: string, schema: z.ZodType<T>, maxPages = MAX_PAGES): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const { data, headers } = await githubFetch(`${url}${separator}per_page=100&page=${page}`, token);
    items.push(...parseGitHub(z.array(schema), data));
    const hasNext = /<[^>]+>;\s*rel="next"/.test(headers.get("link") ?? "");
    if (!hasNext) return items;
  }
  throw new HttpError(503, "GITHUB_RESULT_LIMIT", "GitHub has more records than this refresh can safely import");
}

async function fetchWrappedPages<T>(url: string, token: string, key: string, schema: z.ZodType<T>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const { data, headers } = await githubFetch(`${url}${separator}per_page=100&page=${page}`, token);
    const parsed = parseGitHub(z.object({ [key]: z.array(schema) }), data) as Record<string, T[]>;
    items.push(...parsed[key]!);
    if (!/<[^>]+>;\s*rel="next"/.test(headers.get("link") ?? "")) return items;
  }
  throw new HttpError(503, "GITHUB_RESULT_LIMIT", "GitHub has more records than this refresh can safely import");
}

function githubPath(fullName: string): string {
  const [owner, name] = fullName.split("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
}

export function createGitHubGateway(config: AppConfig): GitHubGateway {
  const app = requireGitHubApp(config);
  async function installationToken(installationId: string, repositoryId?: string): Promise<string> {
    let privateKey: string;
    try { privateKey = await readFile(app.privateKeyPath, "utf8"); }
    catch { throw new HttpError(503, "GITHUB_KEY_UNAVAILABLE", "GitHub App private key is unavailable"); }
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId })).toString("base64url");
    let signature: string;
    try { signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey, "base64url"); }
    catch { throw new HttpError(503, "GITHUB_KEY_UNAVAILABLE", "GitHub App private key is invalid"); }
    const { data } = await githubFetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, `${header}.${payload}.${signature}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(repositoryId ? { repository_ids: [Number(repositoryId)] } : {}),
    });
    return parseGitHub(z.object({ token: z.string().min(1) }), data).token;
  }
  return {
    authorizationUrl(state, verifier) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", app.clientId);
      url.searchParams.set("redirect_uri", app.callbackUrl);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge(verifier));
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    async exchangeCode(code, verifier) {
      let response: Response;
      try { response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code, code_verifier: verifier, redirect_uri: app.callbackUrl }),
      }); }
      catch { throw new HttpError(502, "GITHUB_UNAVAILABLE", "GitHub authorization is unavailable"); }
      if (!response.ok) throw await githubError(response);
      let result: unknown;
      try { result = await response.json() as unknown; }
      catch { throw new HttpError(502, "GITHUB_INVALID_RESPONSE", "GitHub returned an invalid authorization response"); }
      const parsed = parseGitHub(z.object({ access_token: z.string().optional(), error: z.string().optional() }), result);
      if (!parsed.access_token || parsed.error) throw new HttpError(400, "GITHUB_AUTH_FAILED", "GitHub authorization failed");
      return parsed.access_token;
    },
    async verifyUserRepository(token, expectedUserId, fullName) {
      const user = parseGitHub(z.object({ id: githubId }), (await githubFetch("https://api.github.com/user", token)).data);
      if (String(user.id) !== expectedUserId) throw new HttpError(403, "GITHUB_ACCOUNT_MISMATCH", "Authorize with the GitHub account used for PatchWork sign-in");
      const installations = await fetchWrappedPages("https://api.github.com/user/installations", token, "installations", z.object({ id: githubId }));
      for (const installation of installations) {
        const repositories = await fetchWrappedPages(`https://api.github.com/user/installations/${installation.id}/repositories`, token,
          "repositories", z.object({ id: githubId, full_name: z.string().min(3) }));
        const found = repositories.find((repo) => repo.full_name.toLowerCase() === fullName.toLowerCase());
        if (found) return { installationId: String(installation.id), repositoryId: String(found.id) };
        }
      throw new HttpError(403, "GITHUB_PERMISSION_DENIED", "Install the GitHub App on this repository and authorize access with your signed-in account");
    },
    async fetchSnapshot(installationId, repositoryId, fullName) {
      const token = await installationToken(installationId, repositoryId);
      const base = githubPath(fullName);
      const repository = parseGitHub(repositorySchema, (await githubFetch(base, token)).data);
      const [rawIssues, pulls, events] = await Promise.all([
        fetchGitHubPages(`${base}/issues?state=all&sort=updated&direction=desc`, token, issueSchema),
        fetchGitHubPages(`${base}/pulls?state=all&sort=updated&direction=desc`, token, pullSchema),
        fetchGitHubPages(`${base}/issues/events`, token, eventSchema),
      ]);
      return { repository, issues: rawIssues.filter((issue) => !issue.pull_request), pulls, events };
    },
  };
}
