import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginPage from "./page";

describe("login page", () => {
  it("keeps the existing GitHub sign-in route and describes current features", () => {
    const html = renderToStaticMarkup(<LoginPage />);

    expect(html).toContain('href="/auth/github/start"');
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain("Plan tasks together and follow progress from list to board.");
    expect(html).toContain("linked GitHub issues, pull requests, and repository activity");
    expect(html).toContain("evidence-backed project health insights");
    expect(html).toContain("A workspace owner connects repository access separately through a GitHub App.");
  });
});
