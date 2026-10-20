// JuiceManager: orchestrates visual and haptic-style juice:
// trauma camera shake, hit-stop, ball ribbon trail, instanced goal/contact bursts,
// squash/stretch, and FOV punches.
import * as THREE from 'three';
import { Time } from '../core/Time.js';
import { Config } from '../core/Config.js';
import { events } from '../core/EventBus.js';

export class JuiceManager {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;

    this.trauma = 0;
    this.fovPunch = 0;
    this.baseFov = camera.fov;

    this._shakeOffset = new THREE.Vector3();
    this._time = 0;

    this.buildRibbonTrail();
    this.buildGoalBurstParticles();
    this.bindEvents();
  }

  buildRibbonTrail() {
    this.trailLength = 16;
    this.trailPositions = new Float32Array(this.trailLength * 3);
    this.trailColors = new Float32Array(this.trailLength * 3);

    for (let i = 0; i < this.trailLength * 3; i++) {
      this.trailPositions[i] = 0;
      this.trailColors[i] = 1.0;
    }

    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trailGeo.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 3));

    this.trailMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      linewidth: 2,
    });

    this.trailLine = new THREE.Line(this.trailGeo, this.trailMat);
    this.trailLine.frustumCulled = false;
    this.scene.add(this.trailLine);
  }

  buildGoalBurstParticles() {
    this.burstCount = 120;
    this.burstGeo = new THREE.BufferGeometry();
    this.burstPositions = new Float32Array(this.burstCount * 3);
    this.burstVelocities = new Float32Array(this.burstCount * 3);
    this.burstLife = new Float32Array(this.burstCount);

    this.burstGeo.setAttribute('position', new THREE.BufferAttribute(this.burstPositions, 3));

    this.burstMat = new THREE.PointsMaterial({
      color: 0x00e5ff,
      size: 0.22,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.burstPoints = new THREE.Points(this.burstGeo, this.burstMat);
    this.burstPoints.frustumCulled = false;
    this.scene.add(this.burstPoints);
  }

  bindEvents() {
    events.on('shot', (e) => {
      if (e.power === 'blast') {
        this.addTrauma(0.55);
        this.fovPunch = Config.JUICE.FOV_PUNCH_BLAST;
        Time.hitStop(Config.JUICE.HIT_STOP_BLAST);
        Time.slowMo(Config.JUICE.SLOW_MO_BLAST, Config.JUICE.SLOW_MO_BLAST_MS);
      } else {
        this.addTrauma(0.25);
        Time.hitStop(Config.JUICE.HIT_STOP_DRIVE);
      }
    });

    events.on('save', () => {
      this.addTrauma(0.4);
      Time.hitStop(Config.JUICE.HIT_STOP_SAVE);
    });

    events.on('woodwork', () => {
      this.addTrauma(0.6);
      Time.hitStop(Config.JUICE.HIT_STOP_WOODWORK);
    });

    events.on('goal', (e) => {
      this.addTrauma(0.75);
      this.triggerGoalBurst(new THREE.Vector3(0, 1.5, Config.GOAL.Z));
    });
  }

  addTrauma(amount) {
    this.trauma = Math.min(1.0, this.trauma + amount);
  }

  triggerGoalBurst(origin) {
    this.burstMat.opacity = 1.0;
    const pos = this.burstPositions;
    const vel = this.burstVelocities;
    const life = this.burstLife;

    for (let i = 0; i < this.burstCount; i++) {
      const idx = i * 3;
      pos[idx] = origin.x;
      pos[idx + 1] = origin.y;
      pos[idx + 2] = origin.z;

      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * Math.PI;
      const speed = 6.0 + Math.random() * 12.0;

      vel[idx] = Math.cos(phi) * Math.cos(theta) * speed;
      vel[idx + 1] = Math.sin(phi) * speed + 2.0;
      vel[idx + 2] = Math.cos(phi) * Math.sin(theta) * speed;
      life[i] = 1.0;
    }
    this.burstGeo.attributes.position.needsUpdate = true;
  }

  update(dt, ball) {
    this._time += dt;

    // --- Trauma Shake Update ---
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - Config.JUICE.CAMERA_TRAUMA_DECAY * dt);
      const shake = this.trauma * this.trauma;
      const maxDist = Config.JUICE.CAMERA_MAX_SHAKE;

      // Pseudo-random noise shake
      this._shakeOffset.set(
        (Math.sin(this._time * 45) + Math.sin(this._time * 93)) * 0.5 * maxDist * shake,
        (Math.cos(this._time * 52) + Math.cos(this._time * 110)) * 0.5 * maxDist * shake,
        (Math.sin(this._time * 61)) * 0.3 * maxDist * shake
      );
      this.camera.position.add(this._shakeOffset);
      this.camera.rotation.z += (Math.sin(this._time * 35) * 0.05 * shake);
    }

    // --- FOV Punch Decay ---
    if (this.fovPunch > 0) {
      this.fovPunch = Math.max(0, this.fovPunch - dt * 15.0);
      this.camera.fov = this.baseFov + this.fovPunch;
      this.camera.updateProjectionMatrix();
    }

    // --- Ball Ribbon Trail Update ---
    if (ball) {
      const bp = ball.position;
      const pos = this.trailPositions;
      const col = this.trailColors;

      // Shift existing positions
      for (let i = this.trailLength - 1; i > 0; i--) {
        pos[i * 3] = pos[(i - 1) * 3];
        pos[i * 3 + 1] = pos[(i - 1) * 3 + 1];
        pos[i * 3 + 2] = pos[(i - 1) * 3 + 2];
      }
      pos[0] = bp.x;
      pos[1] = bp.y;
      pos[2] = bp.z;

      // Color based on spin: magenta (left curve), cyan (right curve), white (knuckle)
      let r = 0, g = 0.9, bCol = 1.0;
      if (ball.isKnuckle) {
        r = 1.0; g = 1.0; bCol = 1.0;
      } else if (ball.spin > 0.1) {
        r = 1.0; g = 0.15; bCol = 0.5; // Magenta
      } else if (ball.spin < -0.1) {
        r = 0.0; g = 0.9; bCol = 1.0; // Cyan
      }

      for (let i = 0; i < this.trailLength; i++) {
        const fade = 1 - (i / this.trailLength);
        col[i * 3] = r * fade;
        col[i * 3 + 1] = g * fade;
        col[i * 3 + 2] = bCol * fade;
      }

      this.trailGeo.attributes.position.needsUpdate = true;
      this.trailGeo.attributes.color.needsUpdate = true;
      this.trailMat.opacity = Math.min(0.85, ball.horizontalSpeed / 8.0);
    }

    // --- Goal Burst Particles Update ---
    if (this.burstMat.opacity > 0) {
      this.burstMat.opacity = Math.max(0, this.burstMat.opacity - dt * 0.9);
      const bPos = this.burstPositions;
      const bVel = this.burstVelocities;
      for (let i = 0; i < this.burstCount; i++) {
        const idx = i * 3;
        bVel[idx + 1] -= 18.0 * dt; // Gravity
        bPos[idx] += bVel[idx] * dt;
        bPos[idx + 1] += bVel[idx + 1] * dt;
        bPos[idx + 2] += bVel[idx + 2] * dt;
        if (bPos[idx + 1] < 0.05) bPos[idx + 1] = 0.05;
      }
      this.burstGeo.attributes.position.needsUpdate = true;
    }
  }
}
