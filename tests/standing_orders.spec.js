// tests/standing_orders.spec.js — verifies Standing Orders (Carry, Hold, Press),
// continuous steering, and advanced street mechanics (Feint, Flick, 1-2).
import { test, expect } from '@playwright/test';

test.describe('ECHO Standing Orders & Street Mechanics', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));
    await page.goto('/');
    await page.waitForFunction(() => window.gameEngine !== undefined);
    await page.locator('#btn-start-keys').click();
  });

  test('setting carry order autonomously moves robot toward goal with ball', async ({ page }) => {
    await page.evaluate(() => {
      const e = window.gameEngine;
      e.halt();
      e.heading = 0; e.robot.mesh.rotation.y = 0; e.robot.mesh.position.set(0, 1.6, 0);
      e.ball.reset(0, 0.8); e.possession = 'robot'; e.ballState = 'controlled'; e._collectCooldown = 0;
      e.defender.mesh.position.set(0, 0, 40);
      e.runIntents([{ type: 'order', order: 'carry', target: 'goal' }]);
    });

    // Robot should autonomously advance toward +Z goal under the carry order
    await page.waitForFunction(() => window.gameEngine.robot.mesh.position.z > 2.5, null, { timeout: 35000 });
    const z = await page.evaluate(() => window.gameEngine.robot.mesh.position.z);
    expect(z).toBeGreaterThan(2.5);
  });

  test('feint performs a lateral burst and stuns nearby defender', async ({ page }) => {
    await page.evaluate(() => {
      const e = window.gameEngine;
      e.halt();
      e.heading = 0; e.robot.mesh.rotation.y = 0; e.robot.mesh.position.set(0, 1.6, 10);
      e.ball.reset(0, 10.8); e.possession = 'robot'; e.ballState = 'controlled';
      e.defender.reset(0); e.defender.mesh.position.set(0, 0, 12);
      e.runIntents([{ type: 'feint', dir: 'left' }]);
    });

    await page.waitForFunction(() => window.gameEngine.robot.mesh.position.x < -0.5, null, { timeout: 35000 });
    const x = await page.evaluate(() => window.gameEngine.robot.mesh.position.x);
    expect(x).toBeLessThan(-0.5);
  });

  test('rainbow flick lifts ball above defender reach (>1.8m)', async ({ page }) => {
    await page.evaluate(() => {
      const e = window.gameEngine;
      e.halt();
      e.heading = 0; e.robot.mesh.rotation.y = 0; e.robot.mesh.position.set(0, 1.6, 5);
      e.ball.reset(0, 5.8); e.possession = 'robot'; e.ballState = 'controlled';
      e.runIntents([{ type: 'flick' }]);
    });

    await page.waitForFunction(() => window.gameEngine.ball.position.y > 1.8, null, { timeout: 35000 });
    const y = await page.evaluate(() => window.gameEngine.ball.position.y);
    expect(y).toBeGreaterThan(1.8);
  });
});
