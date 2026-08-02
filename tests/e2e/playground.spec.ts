import { expect, test } from "@playwright/test";

test("runs a decision-only preset", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Make every model choice/i })).toBeVisible();
  await page.getByTestId("run-decision").click();
  await expect(page.getByTestId("selected-model")).toContainText("demo-code-pro");
});

test("navigates every playground menu page", async ({ page }) => {
  await page.goto("/");

  const pages = [
    ["Policy editor", "Version routing rules with your codebase."],
    ["Request builder", "Build a request before it reaches a provider."],
    ["Decision explorer", "Inspect every routing decision."],
    ["Candidate comparison", "Every elimination is visible."],
    ["Replay report", "Replay report"],
    ["Evaluation report", "Evaluation report"],
    ["Architecture", "Constraints before optimization."],
    ["Documentation", "What to explore next."],
    ["Overview", "See the policy make the call."],
  ] as const;

  for (const [label, heading] of pages) {
    const menuItem = page.getByRole("button", { name: label, exact: true });
    await expect(menuItem).toHaveCount(1);
    await menuItem.click();
    await expect(menuItem).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("page-heading")).toContainText(heading);
    await expect(page.getByTestId("page-heading")).toBeInViewport();
  }
});
