// OrderManager: manages persistent Standing Orders that run continuously
// in the background whenever one-shot actions are not blocking the queue.
import * as THREE from 'three';
import { Steering } from './Steering.js';
import { events } from '../core/EventBus.js';
import { Config } from '../core/Config.js';

const _targetPos = new THREE.Vector3();
const _desiredDir = new THREE.Vector3();
const _avoidDir = new THREE.Vector3();

export const ORDER_DEFS = {
  carry: { label: 'CARRY', icon: '⚡', color: 0x00e5ff },
  hold: { label: 'HOLD', icon: '🛡️', color: 0x00e676 },
  press: { label: 'PRESS', icon: '🎯', color: 0xff9100 },
  screen: { label: 'SCREEN', icon: '🧱', color: 0x7c4dff },
  support: { label: 'SUPPORT', icon: '🤝', color: 0x29b6f6 },
};

export class OrderManager {
  constructor() {
    this.currentOrder = null;
    this._stateTimer = 0;
    this._evasionHeading = 0;
  }

  /**
   * Set a new standing order.
   * @param {string|object} order 
   */
  setOrder(order) {
    if (!order) {
      this.clearOrder('explicit');
      return;
    }
    const type = typeof order === 'string'
      ? order
      : (order.order || (order.type !== 'order' ? order.type : 'carry'));
    const def = ORDER_DEFS[type] || ORDER_DEFS.carry;
    const target = typeof order === 'object' ? order.target : 'goal';

    this.currentOrder = {
      type,
      target,
      label: `${def.label} ${target === 'goal' ? '→ GOAL' : target ? target.toUpperCase() : ''}`.trim(),
      icon: def.icon,
      color: def.color,
    };

    events.emit('order_set', this.currentOrder);
  }

  clearOrder(reason = 'explicit') {
    if (this.currentOrder) {
      this.currentOrder = null;
      events.emit('order_cleared', { reason });
    }
  }

  hasOrder() {
    return Boolean(this.currentOrder);
  }

  /**
   * Execute autonomous behavior for the active Standing Order.
   * Called every physics tick when there is no active blocking action.
   */
  update(dt, ctx) {
    if (!this.currentOrder) return;

    const { type } = this.currentOrder;
    const rp = ctx.robot.mesh.position;
    const bp = ctx.ball.position;
    const bv = ctx.ball.vel;
    const hasBall = ctx.possession === 'robot';

    switch (type) {
      case 'carry':
        this._updateCarry(dt, ctx, rp, bp, hasBall);
        break;
      case 'hold':
        this._updateHold(dt, ctx, rp, bp, hasBall);
        break;
      case 'press':
        this._updatePress(dt, ctx, rp, bp, bv, hasBall);
        break;
      case 'screen':
        this._updateScreen(dt, ctx, rp, bp, hasBall);
        break;
      case 'support':
        this._updateSupport(dt, ctx, rp, bp, hasBall);
        break;
      default:
        break;
    }
  }

  _updateCarry(dt, ctx, rp, bp, hasBall) {
    // If we don't have the ball yet, press to recover it first
    if (!hasBall) {
      this._updatePress(dt, ctx, rp, bp, ctx.ball.vel, false);
      return;
    }

    // Target goal zone
    const gz = ctx.goal.z;
    let targetX = 0;
    if (this.currentOrder.target === 'left') targetX = -ctx.goal.w * 0.4;
    else if (this.currentOrder.target === 'right') targetX = ctx.goal.w * 0.4;

    _targetPos.set(targetX, 0, gz - 2.0);

    // Obstacle avoidance against defenders
    _desiredDir.set(_targetPos.x - rp.x, 0, _targetPos.z - rp.z).normalize();
    const obstacles = [];
    if (ctx.defender && ctx.defender.mesh) {
      obstacles.push({ pos: ctx.defender.mesh.position, radius: 1.6 });
    }

    Steering.avoidObstacles(rp, _desiredDir, obstacles, _avoidDir);
    _targetPos.copy(rp).addScaledVector(_avoidDir, 6.0);

    const { throttle, steer, dist } = Steering.seek(rp, ctx.heading, _targetPos, 3.0);
    ctx.setSteer(steer);

    // If pressured tightly and facing away or cornered, shield momentarily
    if (ctx.defenderNear && dist < 2.0) {
      ctx.setRunning(false);
      ctx.setThrottle(0.3);
    } else {
      ctx.setRunning(true);
      ctx.setThrottle(throttle);
    }
  }

  _updateHold(dt, ctx, rp, bp, hasBall) {
    if (!hasBall) {
      this._updatePress(dt, ctx, rp, bp, ctx.ball.vel, false);
      return;
    }
    ctx.setThrottle(0);
    ctx.setRunning(false);

    // Turn back toward defender to shield
    if (ctx.defender && ctx.defender.mesh) {
      const dp = ctx.defender.mesh.position;
      const shieldHeading = Math.atan2(rp.x - dp.x, rp.z - dp.z);
      const delta = Math.atan2(Math.sin(shieldHeading - ctx.heading), Math.cos(shieldHeading - ctx.heading));
      ctx.setSteer(THREE.MathUtils.clamp(delta * 2.0, -1, 1));
    } else {
      ctx.setSteer(0);
    }
  }

  _updatePress(dt, ctx, rp, bp, bv, hasBall) {
    if (hasBall) {
      // Re-acquired ball! Transition to carry
      this.currentOrder.type = 'carry';
      this.currentOrder.label = 'CARRY → GOAL';
      this.currentOrder.color = ORDER_DEFS.carry.color;
      events.emit('order_set', this.currentOrder);
      return;
    }

    // Intercept ball
    const { point, time } = Steering.predictIntercept(rp, Config.ROBOT.RUN_SPEED, bp, bv, _targetPos);
    const { throttle, steer, dist } = Steering.seek(rp, ctx.heading, point, 1.2);

    ctx.setSteer(steer);
    ctx.setRunning(true);
    ctx.setThrottle(throttle);
  }

  _updateScreen(dt, ctx, rp, bp, hasBall) {
    // Position halfway between ball and defending goal (z = -23)
    const ownGoalZ = Config.GOAL.DEFEND_Z;
    _targetPos.set(bp.x * 0.6, 0, (bp.z + ownGoalZ) * 0.5);

    const { throttle, steer } = Steering.seek(rp, ctx.heading, _targetPos, 2.0);
    ctx.setSteer(steer);
    ctx.setRunning(false);
    ctx.setThrottle(throttle);
  }

  _updateSupport(dt, ctx, rp, bp, hasBall) {
    // Provide a passing option off-ball (approx 8m to the side and slightly ahead)
    const flankSign = bp.x > 0 ? -1 : 1;
    _targetPos.set(bp.x + flankSign * 7.0, 0, bp.z + 4.0);

    const { throttle, steer } = Steering.seek(rp, ctx.heading, _targetPos, 2.0);
    ctx.setSteer(steer);
    ctx.setRunning(true);
    ctx.setThrottle(throttle);
  }
}
