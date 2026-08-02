import { expect, test } from "@playwright/test";

test("runs a decision-only preset", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Make every model choice/i })).toBeVisible();
  await page.getByTestId("run-decision").click();
  await expect(page.getByTestId("selected-model")).toContainText("demo-code-pro");
});
