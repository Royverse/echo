// Steering and predictive intercept utilities for ECHO.
// Pure math, zero per-frame garbage.
import * as THREE from 'three';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _diff = new THREE.Vector3();

export class Steering {
  /**
   * Predict intercept point for a moving target (ball).
   * @param {THREE.Vector3} chaserPos 
   * @param {number} chaserSpeed 
   * @param {THREE.Vector3} targetPos 
   * @param {THREE.Vector3} targetVel 
   * @returns {{ point: THREE.Vector3, time: number }}
   */
  static predictIntercept(chaserPos, chaserSpeed, targetPos, targetVel, outPoint = new THREE.Vector3()) {
    _diff.subVectors(targetPos, chaserPos);
    _diff.y = 0;
    const dist = _diff.length();
    const speed = Math.max(0.1, chaserSpeed);

    // Iterative lead estimate (1-2 iterations is highly accurate for arcade physics)
    let tLead = dist / speed;
    _v1.copy(targetVel);
    _v1.y = 0;

    // First order lead
    outPoint.copy(targetPos).addScaledVector(_v1, tLead * 0.85);
    outPoint.y = targetPos.y;

    const refinedDist = Math.hypot(outPoint.x - chaserPos.x, outPoint.z - chaserPos.z);
    tLead = refinedDist / speed;
    outPoint.copy(targetPos).addScaledVector(_v1, Math.min(2.5, tLead));
    outPoint.y = targetPos.y;

    return { point: outPoint, time: tLead };
  }

  /**
   * Compute throttle and steer to drive toward a world target point.
   * @param {THREE.Vector3} currentPos 
   * @param {number} currentHeading 
   * @param {THREE.Vector3} targetPos 
   * @param {number} slowingDist 
   * @returns {{ throttle: number, steer: number, dist: number, deltaHeading: number }}
   */
  static seek(currentPos, currentHeading, targetPos, slowingDist = 2.0) {
    const dx = targetPos.x - currentPos.x;
    const dz = targetPos.z - currentPos.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 0.05) {
      return { throttle: 0, steer: 0, dist, deltaHeading: 0 };
    }

    const targetHeading = Math.atan2(dx, dz);
    let deltaHeading = Math.atan2(Math.sin(targetHeading - currentHeading), Math.cos(targetHeading - currentHeading));

    // Steer clamped to -1..1
    const steer = THREE.MathUtils.clamp(deltaHeading * 1.8, -1, 1);

    // Ease throttle as we arrive or if we need a sharp pivot
    const facingAlignment = Math.max(0, Math.cos(deltaHeading));
    const arrivalEase = THREE.MathUtils.clamp(dist / slowingDist, 0.2, 1.0);
    const throttle = facingAlignment * arrivalEase;

    return { throttle, steer, dist, deltaHeading };
  }

  /**
   * Apply repulsive avoidance force around obstacles (defenders).
   * @param {THREE.Vector3} pos 
   * @param {THREE.Vector3} desiredDir 
   * @param {Array<{pos: THREE.Vector3, radius: number}>} obstacles 
   * @param {THREE.Vector3} outDir 
   */
  static avoidObstacles(pos, desiredDir, obstacles, outDir = new THREE.Vector3()) {
    outDir.copy(desiredDir).normalize();
    for (const obs of obstacles) {
      if (!obs || !obs.pos) continue;
      _diff.subVectors(pos, obs.pos);
      _diff.y = 0;
      const d = _diff.length();
      const avoidRadius = (obs.radius || 1.8) + 1.2;
      if (d < avoidRadius && d > 0.01) {
        const strength = (1 - d / avoidRadius) * 2.0;
        _diff.normalize();
        outDir.addScaledVector(_diff, strength);
      }
    }
    outDir.y = 0;
    return outDir.normalize();
  }
}
