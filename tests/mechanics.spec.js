// tests/mechanics.spec.js — momentum locomotion + cinematic follow camera.
import { test, expect } from '@playwright/test';

test.describe('ECHO mechanics', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));
    await page.goto('/');
    await page.waitForFunction(() => window.gameEngine !== undefined);
    await page.locator('#btn-start-keys').click();
  });

  test('counted walk moves forward then settles to a stop', async ({ page }) => {
    await page.evaluate(() => window.gameEngine.runIntents([{ type: 'move', dir: 'forward', steps: 4 }]));

    // wait until the move goal completes and speed returns to ~0
    await page.waitForFunction(() => window.gameEngine.speed === 0 && !window.gameEngine.moveGoal, null, { timeout: 15000 });

    const z = await page.evaluate(() => window.gameEngine.robot.mesh.position.z);
    // 4 steps * 1.6 units ≈ 6.4 forward (+Z at heading 0)
    expect(z).toBeGreaterThan(4);
  });

  test('turn around rotates ~180° and the camera follows behind', async ({ page }) => {
    await page.evaluate(() => window.gameEngine.runIntents([{ type: 'turn', dir: 'around' }]));
    await page.waitForFunction(() => !window.gameEngine.turnGoal, null, { timeout: 8000 });
    // let the chase camera settle behind the new facing
    await page.waitForTimeout(1200);

    const state = await page.evaluate(() => ({
      heading: Math.abs(window.gameEngine.heading),
      camZ: window.gameEngine.camera.position.z,
      robotZ: window.gameEngine.robot.mesh.position.z,
    }));

    expect(state.heading).toBeGreaterThan(3.0);
    // facing -Z now, so the follow camera should sit on the +Z side (behind it)
    expect(state.camZ).toBeGreaterThan(state.robotZ);
  });

  test('stop halts an in-progress continuous walk', async ({ page }) => {
    await page.evaluate(() => window.gameEngine.runIntents([{ type: 'move', dir: 'forward' }]));
    await page.waitForFunction(() => window.gameEngine.speed > 1, null, { timeout: 4000 });
    await page.evaluate(() => window.gameEngine.runIntents([{ type: 'stop' }]));
    await page.waitForFunction(() => window.gameEngine.speed === 0, null, { timeout: 4000 });
    expect(await page.evaluate(() => window.gameEngine.throttle)).toBe(0);
  });

  test('diagonal walk turns first then moves forward', async ({ page }) => {
    await page.evaluate(() => window.gameEngine.runIntents([{ type: 'move', dir: 'forward-left', steps: 3 }]));
    
    // Wait for the sequence to complete (turn then move)
    await page.waitForFunction(() => window.gameEngine.speed === 0 && !window.gameEngine.moveGoal && !window.gameEngine.turnGoal, null, { timeout: 15000 });
    
    const state = await page.evaluate(() => ({
      heading: window.gameEngine.heading,
      x: window.gameEngine.robot.mesh.position.x,
      z: window.gameEngine.robot.mesh.position.z,
    }));
    
    // Heading should be ~45 degrees (Math.PI / 4 ≈ 0.785)
    expect(state.heading).toBeCloseTo(Math.PI / 4, 1);
    // x and z should be positive (diagonal motion)
    expect(state.x).toBeGreaterThan(2);
    expect(state.z).toBeGreaterThan(2);
  });
});
