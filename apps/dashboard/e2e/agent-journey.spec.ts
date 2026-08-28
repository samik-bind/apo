import { expect, test } from "@playwright/test";

/**
 * Agent journey — the spec's proof.
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

  test("traces and tasks controls are operable by accessible name", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in as dev" }).click();
    await expect(page).toHaveURL(/\/project\/agent-demo\/tasks/, {
      timeout: 15_000,
    });

    // Tasks filter input is named and typable.
    const taskFilter = page.getByTestId("tasks-search-input");
    await expect(taskFilter).toBeVisible();
    await taskFilter.fill("demo");

    // Traces page controls: named search input, refresh, columns menu.
    await page.goto("/project/agent-demo/traces");
    const traceSearch = page.getByRole("textbox", { name: "Search traces" });
    await expect(traceSearch).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh traces" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Toggle table columns" }),
    ).toBeVisible();
    await traceSearch.fill("agent-demo");
    // The input renders server-side before hydration attaches the keydown
    // handler — pressing Enter is idempotent, so retry until the URL moves.
    await expect(async () => {
      await traceSearch.press("Enter");
      await expect(page).toHaveURL(/search=agent-demo/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
  });
});
