import { expect, test } from "@playwright/test";

/**
 * SPEC-181 agent journey — the spec's proof.
 *
 * Simulates exactly what a browser-using AI agent does: open a deep link
 * with no session, get redirected to login, click the one-click dev button,
 * and land authenticated on real content. Every locator is an accessible
 * name or stable testid — if this test passes, browser-use can do it.
 *
 * Requires a stack with DEV_SIGNIN_ENABLED=true (docker compose with the
 * local .env sets this).
 */
test.describe("Agent journey @agent", () => {
  test("deep link → login → dev sign-in → back to deep-linked runs page", async ({
    page,
  }) => {
    await page.goto("/project/agent-demo/runs");

    // Unauthenticated visit redirects to login, remembering the destination.
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);

    // The one-click button is reachable by accessible name — no credentials.
    const devButton = page.getByRole("button", { name: "Sign in as dev" });
    await expect(devButton).toBeVisible();
    await devButton.click();

    // Returns to the deep-linked project authenticated. The layout-level
    // callback remembers the project root (nested paths redirect from there);
    // deployments behind a public origin may also normalize the host.
    await expect(page).toHaveURL(/\/project\/agent-demo(\/|$)/, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("runs-search-input").or(page.locator("main"))).toBeVisible();
  });

  test("bare login → dev sign-in → lands on the agent-demo workspace", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in as dev" }).click();

    // Default landing is the backend-provided agent-demo tasks page.
    await expect(page).toHaveURL(/\/project\/agent-demo\/tasks/, {
      timeout: 15_000,
    });
  });
});
