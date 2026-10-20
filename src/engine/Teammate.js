// Procedural AI Teammate (Nova / Pixel) for ECHO.
// Operates under squad commands (overlap, make a run, pass option, cover)
// with role-based positioning, passing-lane awareness, and first-time finishing.
import * as THREE from 'three';
import { Steering } from '../orders/Steering.js';
import { Config } from '../core/Config.js';
import { events } from '../core/EventBus.js';

const _target = new THREE.Vector3();

export class Teammate {
  constructor(name = 'Nova', colorHex = 0xffab00) {
    this.name = name;
    this.colorHex = colorHex;
    this.role = 'SUPPORT'; // 'SUPPORT' | 'RUN' | 'COVER' | 'RECEIVING'
    this.speed = 0;
    this.heading = 0;
    this.hasBall = false;

    this.mesh = new THREE.Group();
    this.build();
    this.reset();
  }

  build() {
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x454d5a, roughness: 0.35, metalness: 0.8 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x6e7888, roughness: 0.4, metalness: 0.7 });
    const glowMat = new THREE.MeshStandardMaterial({
      color: this.colorHex,
      emissive: this.colorHex,
      emissiveIntensity: 0.5,
      roughness: 0.2,
    });

    this.body = new THREE.Group();
    this.mesh.add(this.body);

    // Torso
    const torsoMesh = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.95, 0.55), metalMat);
    torsoMesh.castShadow = true;
    torsoMesh.position.y = 1.05;
    this.body.add(torsoMesh);

    // Glowing core
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 16), glowMat);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, 1.15, 0.3);
    this.body.add(core);

    // Head
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 0.5), metalMat);
    head.position.y = 1.8;
    head.castShadow = true;
    this.body.add(head);

    // Visor / Eyes
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.14, 0.05), glowMat);
    visor.position.set(0, 1.8, 0.26);
    this.body.add(visor);

    // Role Indicator Ring (above head)
    this.badge = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.28, 20),
      new THREE.MeshBasicMaterial({ color: this.colorHex, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    this.badge.rotation.x = -Math.PI / 2;
    this.badge.position.y = 2.25;
    this.body.add(this.badge);
  }

  reset(x = 6.0, z = 0.0) {
    this.role = 'SUPPORT';
    this.speed = 0;
    this.heading = 0;
    this.hasBall = false;
    this.mesh.position.set(x, 0, z);
    this.mesh.rotation.y = 0;
  }

  setRole(newRole) {
    this.role = newRole;
    events.emit('teammate_role', { name: this.name, role: newRole });
  }

  update(dt, ctx) {
    const me = this.mesh.position;
    const bp = ctx.ball.position;
    const rp = ctx.robot.mesh.position;

    // Pulse badge above head
    this.badge.rotation.z += dt * 2.0;

    switch (this.role) {
      case 'RUN': {
        // Sprint down the flank into attacking space
        _target.set(Math.sign(me.x || 1) * 8.0, 0, Math.min(ctx.goal.z - 4.0, me.z + 8.0));
        const { throttle, steer } = Steering.seek(me, this.heading, _target, 2.0);
        this.heading += steer * Config.ROBOT.TURN_RATE * dt;
        this.speed = throttle * Config.ROBOT.RUN_SPEED;
        break;
      }

      case 'COVER': {
        // Drop back to screen defense
        _target.set(rp.x * 0.5, 0, Math.max(-15.0, bp.z - 8.0));
        const { throttle, steer } = Steering.seek(me, this.heading, _target, 2.0);
        this.heading += steer * Config.ROBOT.TURN_RATE * dt;
        this.speed = throttle * Config.ROBOT.WALK_SPEED;
        break;
      }

      case 'RECEIVING': {
        // Move towards incoming pass
        const { throttle, steer, dist } = Steering.seek(me, this.heading, bp, 0.5);
        this.heading += steer * Config.ROBOT.TURN_RATE * dt;
        this.speed = throttle * Config.ROBOT.RUN_SPEED;
        if (dist < 1.2 && ctx.ball.horizontalSpeed < 8) {
          this.hasBall = true;
          // First-time finish or pass back
          if (bp.z > ctx.goal.z - 12) {
            ctx.ball.kick(new THREE.Vector3(0, 3, 18), 0.2);
            events.emit('shot', { shooter: this.name, power: 'drive' });
          }
          this.role = 'SUPPORT';
        }
        break;
      }

      case 'SUPPORT':
      default: {
        // Keep a triangular passing lane relative to robot and ball
        const flankSign = rp.x >= 0 ? -1 : 1;
        _target.set(rp.x + flankSign * 7.0, 0, rp.z + 3.0);
        const { throttle, steer } = Steering.seek(me, this.heading, _target, 3.0);
        this.heading += steer * Config.ROBOT.TURN_RATE * dt;
        this.speed = throttle * (distTo(_target, me) > 4.0 ? Config.ROBOT.RUN_SPEED : Config.ROBOT.WALK_SPEED);
        break;
      }
    }

    // Integrate
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    me.addScaledVector(fwd, this.speed * dt);
    this.mesh.rotation.y = this.heading;
  }
}

function distTo(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
