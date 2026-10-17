export type RepositoryAvailability = "setup" | "connect" | "cached" | "live";

export function repositoryAvailability(configured: boolean, hasRepository: boolean, disconnected: boolean): RepositoryAvailability {
  if (!hasRepository) return configured ? "connect" : "setup";
  return configured && !disconnected ? "live" : "cached";
}

const connectionErrors: Record<string, string> = {
  GITHUB_ACCOUNT_MISMATCH: "Authorize with the GitHub account used to sign in to PatchWork.",
  GITHUB_AUTH_FAILED: "GitHub authorization was not completed. Try connecting again.",
  GITHUB_PERMISSION_DENIED: "Install the GitHub App on this repository and make sure your GitHub account can access it.",
  GITHUB_RATE_LIMITED: "GitHub API rate limit reached. Wait and try again later.",
  GITHUB_ACCESS_REVOKED: "GitHub authorization expired or was revoked. Try connecting again.",
  GITHUB_NOT_CONFIGURED: "GitHub App setup is incomplete on the server.",
  GITHUB_KEY_UNAVAILABLE: "The server cannot use its GitHub App private key. Ask the project maintainer to check the configured key file and API access, then try again.",
  GITHUB_RESULT_LIMIT: "This repository has more records than one refresh can import. The previous snapshot is unchanged; ask the project maintainer to review the import limit.",
  GITHUB_INVALID_RESPONSE: "GitHub returned data PatchWork could not read. Wait and try again, or ask the project maintainer to investigate.",
  GITHUB_UNAVAILABLE: "GitHub is temporarily unavailable. Wait and try again.",
  GITHUB_REPOSITORY_MISMATCH: "GitHub returned a different repository. Check the selected installation and try again.",
  REPOSITORY_CONNECTED: "This workspace already has a connected repository.",
};

export function connectionErrorMessage(code: string): string {
  return Object.hasOwn(connectionErrors, code)
    ? connectionErrors[code]!
    : "GitHub connection failed. Check the App installation and try again.";
}
