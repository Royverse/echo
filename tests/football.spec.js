// tests/football.spec.js — voice-driven football: possession, placed shooting,
// a diving keeper, and a tackling defender. (Local parser path, no network.)
//
// These drive the real rAF loop and wait on wall-clock for sim milestones; the
// headless software renderer runs the sim in slow motion, so timeouts are large.
import { test, expect } from '@playwright/test';

// Park the opponents far away so a test about one mechanic isn't disturbed.
const PARK_OPPONENTS = `e.defender.mesh.position.set(0,0,40);`;

test.describe('ECHO football', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));
    await page.goto('/');
    await page.waitForFunction(() => window.gameEngine !== undefined);
    await page.locator('#btn-start-keys').click();
  });

  test('a kick sends the ball forward', async ({ page }) => {
    await page.evaluate(() => {
      const e = window.gameEngine;
      e.halt();
      e.heading = 0; e.robot.mesh.rotation.y = 0; e.robot.mesh.position.set(0, 1.6, 0);
      e.ball.reset(0, 0.8); e.possession = 'robot'; e.ballState = 'controlled'; e._collectCooldown = 0;
      e.defender.mesh.position.set(0, 0, 40);
      e.runIntents([{ type: 'kick', power: 'blast' }]);
    });
    await page.waitForFunction(() => window.gameEngine.ball.position.z > 2.5, null, { timeout: 40000 });
    expect(await page.evaluate(() => window.gameEngine.ball.position.z)).toBeGreaterThan(2.5);
  });

  test('a chip lifts the ball off the ground', async ({ page }) => {
    await page.evaluate(() => {
      const e = window.gameEngine;
      e.halt();
      e.heading = 0; e.robot.mesh.rotation.y = 0; e.robot.mesh.position.set(0, 1.6, 0);
      e.ball.reset(0, 0.8); e.possession = 'robot'; e.ballState = 'controlled'; e._collectCooldown = 0;
      e.defender.mesh.position.set(0, 0, 40);
      e.runIntents([{ type: 'kick', power: 'drive', loft: 'chip' }]);
    });
    await page.waitForFunction(() => window.gameEngine.ball.position.y > 1.0, null, { timeout: 40000 });
    expect(await page.evaluate(() => window.gameEngine.ball.position.y)).toBeGreaterThan(1.0);
  });

  test('juggling ticks the keepie-uppie counter', async ({ page }) => {
    await page.evaluate(() => window.gameEngine.runIntents([{ type: 'juggle' }]));
    await page.waitForFunction(() => window.gameEngine.juggleStreak >= 1, null, { timeout: 40000 });
    expect(await page.evaluate(() => window.gameEngine.juggleStreak)).toBeGreaterThan(0);
  });

  test('possession carries the ball through a move', async ({ page }) => {
    await page.evaluate(() => {
      const e = window.gameEngine;
      e.halt();
      e.heading = 0; e.robot.mesh.rotation.y = 0; e.robot.mesh.position.set(0, 1.6, 0);
      e.ball.reset(0, 1.0); e.possession = null; e._collectCooldown = 0;
      e.defender.mesh.position.set(0, 0, 40);
      e.runIntents([{ type: 'dribble', dir: 'forward', steps: 4 }]);
    });
    // Dribble runs to completion with the ball still under control.
    await page.waitForFunction(() => {
      const e = window.gameEngine;
      return e.possession === 'robot' && !e.moveGoal && Math.abs(e.speed) < 0.2;
    }, null, { timeout: 40000 });
    const state = await page.evaluate(() => {
      const e = window.gameEngine, p = e.robot.mesh.position, b = e.ball.position;
      return { gap: Math.hypot(b.x - p.x, b.z - p.z), robotZ: p.z };
    });
    expect(state.robotZ).toBeGreaterThan(3);   // it actually moved
    expect(state.gap).toBeLessThan(1.6);        // and the ball came with it
  });

  test('a placed shot into the corner beats the keeper and scores', async ({ page }) => {
    await page.evaluate(() => {
      const e = window.gameEngine;
      e.halt();
      e.heading = 0; e.robot.mesh.rotation.y = 0; e.robot.mesh.position.set(0, 1.6, 8);
      e.ball.reset(0, 8.7); e.possession = 'robot'; e.ballState = 'controlled'; e._collectCooldown = 0;
      e.keeper.reset(); e.defender.mesh.position.set(0, 0, 40);
      e.score.goals = 0; e.goal.scored = false;
      e.runIntents([{ type: 'kick', power: 'drive', target: 'top-left' }]);
    });
    await page.waitForFunction(() => window.gameEngine.score.goals >= 1, null, { timeout: 40000 });
    expect(await page.evaluate(() => window.gameEngine.score.goals)).toBeGreaterThan(0);
  });

  test('the keeper saves a shot hit straight at him', async ({ page }) => {
    await page.evaluate(() => {
      const e = window.gameEngine;
      e.halt();
      e.heading = 0; e.robot.mesh.rotation.y = 0; e.robot.mesh.position.set(0, 1.6, 8);
      e.ball.reset(0, 8.7); e.possession = 'robot'; e.ballState = 'controlled'; e._collectCooldown = 0;
      e.keeper.reset(); e.defender.mesh.position.set(0, 0, 40);
      e.score.saves = 0; e.goal.scored = false;
      e.runIntents([{ type: 'kick', power: 'drive', target: 'top-center' }]);
    });
    await page.waitForFunction(() => window.gameEngine.score.saves >= 1, null, { timeout: 40000 });
    expect(await page.evaluate(() => window.gameEngine.score.saves)).toBeGreaterThan(0);
  });

  test('an unshielded dribble into the defender is tackled', async ({ page }) => {
    await page.evaluate(() => {
      const e = window.gameEngine;
      e.halt();
      e.heading = 0; e.robot.mesh.rotation.y = 0; e.robot.mesh.position.set(0, 1.6, 11);
      e.ball.reset(0, 11.7); e.possession = 'robot'; e.ballState = 'controlled'; e._collectCooldown = 0;
      e.defender.reset(0); e.defender.mesh.position.set(0, 0, 13.5);
      e.runIntents([{ type: 'dribble', dir: 'forward', steps: 8 }]);
    });
    await page.waitForFunction(() => window.gameEngine.possession === null, null, { timeout: 40000 });
    expect(await page.evaluate(() => window.gameEngine.possession)).toBeNull();
  });
});
