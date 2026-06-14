// tests/ui.spec.js — HUD + manual command pipeline (no network: local parser).
import { test, expect } from '@playwright/test';

test.describe('VOX-BOT HUD', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));
    await page.goto('/');
    await page.waitForFunction(() => window.gameEngine !== undefined);
    // Dismiss the splash (also unlocks audio) and open the command drawer.
    await page.locator('#btn-start-keys').click();
    await page.locator('#btn-help').click();
  });

  test('loads the 3D canvas and branding', async ({ page }) => {
    await expect(page).toHaveTitle(/ECHO/);
    await expect(page.locator('#scene canvas')).toBeVisible();
    await expect(page.locator('.brand')).toContainText('ECH');
  });

  test('manual deck drives the robot via the local parser', async ({ page }) => {
    await page.locator('#cmd-input').fill('walk forward 3 steps');
    await page.locator('#btn-cmd-send').click();
    await expect(page.locator('#action-label')).toContainText('WALKING', { timeout: 4000 });
    await expect(page.locator('#feed')).toContainText('move forward 3');
  });

  test('quick chips issue commands instantly', async ({ page }) => {
    await page.locator('.chip', { hasText: 'Jump' }).click();
    await expect(page.locator('#action-label')).toContainText('JUMPING', { timeout: 4000 });
  });
});
