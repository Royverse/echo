// Procedural robot, fully rigged from primitives. Driven by the engine's
// locomotion state (speed + turn rate) so the gait matches real ground speed.
// Features upper-body kick strike layering over gait, strike-snap easing,
// and procedural animations for feint, flick, and bicycle kick.
import * as THREE from 'three';

export class Robot {
  constructor() {
    this.mesh = new THREE.Group();

    // Transient expressive poses: 'none' | 'wave' | 'dance' | 'kick' | 'juggle' | 'feint' | 'flick' | 'bicycle'
    this.pose = 'none';
    this.airborne = false;

    // Kick one-shot parameters
    this.kickPhase = 0;
    this.kickDuration = 0.7;
    this.kickLeg = -1;        // -1 = right leg, +1 = left leg
    this.KICK_CONTACT = 0.5;  // fraction of the kick at which foot strikes

    this.animTime = 0;
    this.gaitPhase = 0;
    this.jumpBend = 0;
    this.lean = 0;
    this.pitch = 0;

    // Strike-snap offset
    this.strikeSnap = 0;

    this.defaultHeight = 1.6;
    this.walkSpeed = 3.0;

    this.buildRobot();
  }

  buildRobot() {
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x505763, roughness: 0.35, metalness: 0.85 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x788394, roughness: 0.4, metalness: 0.7 });
    const glowCyan = new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 0.4, roughness: 0.2, metalness: 0.1 });
    const glowMagenta = new THREE.MeshStandardMaterial({ color: 0xff2d78, emissive: 0xff2d78, emissiveIntensity: 0.4, roughness: 0.2 });
    this.glowCyan = glowCyan;
    this.glowMagenta = glowMagenta;

    // Torso (parent of head + limbs)
    this.torso = new THREE.Group();
    this.mesh.add(this.torso);

    const torsoMesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.6), metalMat);
    torsoMesh.castShadow = torsoMesh.receiveShadow = true;
    this.torso.add(torsoMesh);

    // Chest plate
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.05), trimMat);
    plate.position.set(0, 0.05, 0.31);
    this.torso.add(plate);

    // Glowing core
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.12, 20), glowCyan);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, 0.12, 0.33);
    this.torso.add(core);
    this.coreLight = new THREE.PointLight(0x00e5ff, 2.2, 4, 2);
    this.coreLight.position.set(0, 0.12, 0.5);
    this.torso.add(this.coreLight);

    // Head + neck
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 0.15, 12), trimMat);
    neck.position.set(0, 0.575, 0);
    this.torso.add(neck);

    this.head = new THREE.Group();
    this.head.position.set(0, 0.8, 0);
    this.torso.add(this.head);

    const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, 0.56), metalMat);
    headMesh.castShadow = true;
    this.head.add(headMesh);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.2, 0.06), new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 0.1, metalness: 0.3 }));
    visor.position.set(0, 0.05, 0.27);
    this.head.add(visor);

    const eyeGeom = new THREE.BoxGeometry(0.11, 0.06, 0.03);
    this.eyeL = new THREE.Mesh(eyeGeom, glowCyan);
    this.eyeL.position.set(-0.13, 0.05, 0.29);
    this.head.add(this.eyeL);
    this.eyeR = this.eyeL.clone();
    this.eyeR.position.x = 0.13;
    this.head.add(this.eyeR);

    // Antenna
    const antBase = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8), trimMat);
    antBase.position.set(0.2, 0.28, 0);
    antBase.rotation.z = -0.15;
    this.head.add(antBase);
    const antPole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 6), trimMat);
    antPole.position.set(0, 0.16, 0);
    antBase.add(antPole);
    const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 10), glowMagenta);
    antTip.position.set(0, 0.3, 0);
    antBase.add(antTip);

    // Arms
    const buildArm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.52 * side, 0.35, 0);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.45, 0.18), metalMat);
      upper.position.y = -0.22;
      upper.castShadow = true;
      shoulder.add(upper);

      const elbow = new THREE.Group();
      elbow.position.y = -0.45;
      shoulder.add(elbow);
      const lower = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.42, 0.15), trimMat);
      lower.position.y = -0.21;
      lower.castShadow = true;
      elbow.add(lower);

      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), metalMat);
      hand.position.y = -0.44;
      elbow.add(hand);

      this.torso.add(shoulder);
      return { shoulder, elbow };
    };

    const rArm = buildArm(-1);
    const lArm = buildArm(1);
    this.rightShoulder = rArm.shoulder; this.rightElbow = rArm.elbow;
    this.leftShoulder = lArm.shoulder; this.leftElbow = lArm.elbow;

    // Legs
    const buildLeg = (side) => {
      const thigh = new THREE.Group();
      thigh.position.set(0.24 * side, -0.5, 0);
      this.mesh.add(thigh);

      const thighMesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.5, 0.24), metalMat);
      thighMesh.position.y = -0.25;
      thighMesh.castShadow = true;
      thigh.add(thighMesh);

      const calf = new THREE.Group();
      calf.position.y = -0.5;
      thigh.add(calf);

      const calfMesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.48, 0.2), metalMat);
      calfMesh.position.y = -0.24;
      calfMesh.castShadow = true;
      calf.add(calfMesh);

      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.28), trimMat);
      foot.position.set(0, -0.42, 0.05);
      foot.castShadow = true;
      calf.add(foot);
      return { thigh, calf };
    };

    const rLeg = buildLeg(-1);
    const lLeg = buildLeg(1);
    this.rightThigh = rLeg.thigh; this.rightCalf = rLeg.calf;
    this.leftThigh = lLeg.thigh; this.leftCalf = lLeg.calf;

    this.mesh.position.y = this.defaultHeight;
  }

  update(dt, motion = {}) {
    const { speed = 0, turnRate = 0, maxSpeed = 6, airborne = false } = motion;
    this.animTime += dt;
    this.airborne = airborne;

    // Blink
    const blink = Math.sin(this.animTime * 0.7) > 0.985 ? 0.12 : 1;
    this.eyeL.scale.y = blink;
    this.eyeR.scale.y = blink;

    if (this.pose === 'dance') { this.animateDance(); return false; }
    if (this.pose === 'wave') { this.animateWave(speed); return false; }
    if (this.pose === 'kick') { this.animateKick(dt); return false; }
    if (this.pose === 'juggle') { this.animateJuggle(); return false; }
    if (this.pose === 'feint') { this.animateFeint(); return false; }
    if (this.pose === 'flick') { this.animateFlick(); return false; }
    if (this.pose === 'bicycle') { this.animateBicycle(); return false; }

    return this.animateLocomotion(dt, speed, turnRate, maxSpeed, airborne);
  }

  animateLocomotion(dt, speed, turnRate, maxSpeed, airborne) {
    const absSpeed = Math.abs(speed);
    const move = THREE.MathUtils.clamp(absSpeed / (maxSpeed * 0.45), 0, 1);
    const run = THREE.MathUtils.clamp((absSpeed - this.walkSpeed) / Math.max(0.1, maxSpeed - this.walkSpeed), 0, 1);
    const sign = speed < 0 ? -1 : 1;

    const prevPhase = this.gaitPhase;
    this.gaitPhase += absSpeed * 1.7 * dt;
    const cycle = this.gaitPhase * sign;

    const targetLean = THREE.MathUtils.clamp(-turnRate * 0.18 * (0.4 + move), -0.35, 0.35);
    const targetPitch = move * sign * (0.06 + run * 0.12);
    this.lean = THREE.MathUtils.lerp(this.lean, targetLean, 0.12);
    this.pitch = THREE.MathUtils.lerp(this.pitch, targetPitch, 0.1);

    const swing = (0.25 + run * 0.45) * move;
    const armSwing = (0.2 + run * 0.5) * move;
    const bobAmp = (0.04 + run * 0.06) * move;

    this.torso.position.y = THREE.MathUtils.lerp(this.torso.position.y, Math.abs(Math.sin(cycle)) * bobAmp - bobAmp * 0.5, 0.4);
    this.torso.rotation.z = this.lean;
    this.torso.rotation.x = this.pitch;
    this.torso.rotation.y = THREE.MathUtils.lerp(this.torso.rotation.y, Math.sin(cycle) * 0.04 * move, 0.3);
    this.head.rotation.y = THREE.MathUtils.lerp(this.head.rotation.y, -Math.sin(cycle) * 0.03 * move - turnRate * 0.05, 0.2);
    this.head.rotation.z = -this.lean * 0.5;

    const breath = Math.sin(this.animTime * 1.6) * (1 - move);

    if (airborne) {
      this.setLimb(this.leftThigh, 'x', -0.5, 0.2);
      this.setLimb(this.rightThigh, 'x', -0.6, 0.2);
      this.setLimb(this.leftCalf, 'x', 0.7, 0.2);
      this.setLimb(this.rightCalf, 'x', 0.8, 0.2);
      this.setLimb(this.leftShoulder, 'z', 0.7, 0.2);
      this.setLimb(this.rightShoulder, 'z', -0.7, 0.2);
      this.setLimb(this.leftShoulder, 'x', -0.3, 0.2);
      this.setLimb(this.rightShoulder, 'x', -0.3, 0.2);
      return false;
    }

    this.rightThigh.rotation.x = Math.sin(cycle) * swing + this.jumpBend * 0.5;
    this.leftThigh.rotation.x = -Math.sin(cycle) * swing + this.jumpBend * 0.5;
    const kr = Math.sin(cycle - Math.PI / 3);
    const kl = Math.sin(cycle + Math.PI / 3);
    this.rightCalf.rotation.x = (kr > 0 ? -kr * (0.4 + run * 0.4) : 0) - this.jumpBend * 0.7;
    this.leftCalf.rotation.x = (kl > 0 ? -kl * (0.4 + run * 0.4) : 0) - this.jumpBend * 0.7;

    this.leftShoulder.rotation.x = -Math.sin(cycle) * armSwing + breath * 0.05;
    this.rightShoulder.rotation.x = Math.sin(cycle) * armSwing + breath * 0.05;
    this.leftShoulder.rotation.z = THREE.MathUtils.lerp(this.leftShoulder.rotation.z, 0.16 + run * 0.1, 0.2);
    this.rightShoulder.rotation.z = THREE.MathUtils.lerp(this.rightShoulder.rotation.z, -0.16 - run * 0.1, 0.2);
    this.leftElbow.rotation.x = -0.2 - Math.abs(Math.sin(cycle)) * (0.2 + run * 0.3);
    this.rightElbow.rotation.x = -0.2 - Math.abs(Math.cos(cycle)) * (0.2 + run * 0.3);

    if (move > 0.05) {
      const stepBefore = Math.floor((prevPhase * sign) / Math.PI);
      const stepNow = Math.floor(cycle / Math.PI);
      return stepNow !== stepBefore;
    }
    return false;
  }

  setLimb(group, axis, target, t) {
    group.rotation[axis] = THREE.MathUtils.lerp(group.rotation[axis], target, t);
  }

  animateWave(speed) {
    const breath = Math.sin(this.animTime * 1.6);
    [this.leftThigh, this.rightThigh, this.leftCalf, this.rightCalf].forEach((l) => this.setLimb(l, 'x', 0, 0.15));
    this.torso.rotation.set(THREE.MathUtils.lerp(this.torso.rotation.x, 0, 0.1), 0, THREE.MathUtils.lerp(this.torso.rotation.z, 0, 0.1));
    this.lean = this.pitch = 0;

    this.setLimb(this.leftShoulder, 'x', 0.1 + breath * 0.05, 0.1);
    this.setLimb(this.rightShoulder, 'x', -2.5, 0.12);
    this.setLimb(this.rightShoulder, 'z', 0.35, 0.12);
    this.rightElbow.rotation.x = -0.4 + Math.sin(this.animTime * 12) * 0.45;
    this.head.rotation.z = THREE.MathUtils.lerp(this.head.rotation.z, 0.1, 0.1);
  }

  animateDance(speed) {
    const c = this.animTime * 8;
    this.torso.position.y = Math.abs(Math.sin(c)) * 0.16;
    this.torso.rotation.y = Math.sin(c) * 0.45;
    this.torso.rotation.x = Math.cos(c * 0.5) * 0.15;
    this.torso.rotation.z = Math.sin(c * 0.5) * 0.2;
    this.head.rotation.x = -Math.cos(c * 0.5) * 0.25;
    this.head.rotation.y = Math.cos(c) * 0.3;
    this.lean = this.pitch = 0;

    this.leftShoulder.rotation.x = -Math.sin(c) * 1.3;
    this.leftShoulder.rotation.z = 0.3 + Math.cos(c) * 0.35;
    this.rightShoulder.rotation.x = Math.sin(c) * 1.3;
    this.rightShoulder.rotation.z = -0.3 - Math.sin(c) * 0.35;
    this.leftElbow.rotation.x = -0.4 + Math.sin(c) * 0.4;
    this.rightElbow.rotation.x = -0.4 + Math.cos(c) * 0.4;

    this.leftThigh.rotation.x = Math.sin(c) * 0.35;
    this.leftThigh.rotation.z = 0.1 + Math.abs(Math.cos(c)) * 0.2;
    this.rightThigh.rotation.x = -Math.sin(c) * 0.35;
    this.rightThigh.rotation.z = -0.1 - Math.abs(Math.sin(c)) * 0.2;
    this.leftCalf.rotation.x = Math.max(0, Math.sin(c)) * 0.3;
    this.rightCalf.rotation.x = Math.max(0, -Math.sin(c)) * 0.3;
  }

  startKick(duration = 0.7, leg = -1) {
    this.pose = 'kick';
    this.kickPhase = 0;
    this.kickDuration = duration;
    this.kickLeg = leg;
  }

  animateKick(dt) {
    this.kickPhase = Math.min(1, this.kickPhase + dt / this.kickDuration);
    const p = this.kickPhase;
    const leg = this.kickLeg;
    const thigh = leg < 0 ? this.rightThigh : this.leftThigh;
    const calf = leg < 0 ? this.rightCalf : this.leftCalf;
    const otherThigh = leg < 0 ? this.leftThigh : this.rightThigh;
    const otherCalf = leg < 0 ? this.leftCalf : this.rightCalf;

    const easeOut = (x) => 1 - (1 - x) * (1 - x);
    const easeIn = (x) => x * x;
    const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

    this.setLimb(otherThigh, 'x', -0.12, 0.3);
    this.setLimb(otherCalf, 'x', -0.08, 0.3);
    otherThigh.rotation.z = 0;

    let thighX, calfX;
    if (p < 0.45) {
      const w = p / 0.45;
      thighX = THREE.MathUtils.lerp(0, 0.6, easeOut(w));
      calfX = THREE.MathUtils.lerp(0, -0.75, easeOut(w));
    } else if (p < 0.6) {
      const s = (p - 0.45) / 0.15;
      thighX = THREE.MathUtils.lerp(0.6, -0.75 - this.strikeSnap * 0.2, easeIn(s));
      calfX = THREE.MathUtils.lerp(-0.75, 0, s);
    } else {
      const f = (p - 0.6) / 0.4;
      thighX = THREE.MathUtils.lerp(-0.75, 0, easeInOut(f));
      calfX = THREE.MathUtils.lerp(0, -0.12, f);
    }
    thigh.rotation.x = thighX;
    thigh.rotation.z = 0;
    calf.rotation.x = calfX;

    const lean = p < 0.45 ? -0.12 * (p / 0.45) : THREE.MathUtils.clamp(0.16 * (1 - (p - 0.45) / 0.55), 0, 0.16);
    this.torso.rotation.x = THREE.MathUtils.lerp(this.torso.rotation.x, lean, 0.3);
    this.torso.rotation.z = THREE.MathUtils.lerp(this.torso.rotation.z, 0, 0.3);

    this.setLimb(this.leftShoulder, 'x', leg < 0 ? -0.5 : 0.3, 0.2);
    this.setLimb(this.rightShoulder, 'x', leg < 0 ? 0.3 : -0.5, 0.2);
    this.setLimb(this.leftShoulder, 'z', 0.4, 0.2);
    this.setLimb(this.rightShoulder, 'z', -0.4, 0.2);
    this.leftElbow.rotation.x = -0.3;
    this.rightElbow.rotation.x = -0.3;
  }

  animateFeint() {
    const t = Math.sin(this.animTime * 14.0);
    this.torso.rotation.z = t * 0.4;
    this.torso.position.x = t * 0.25;
    this.leftShoulder.rotation.z = 0.5 + t * 0.3;
    this.rightShoulder.rotation.z = -0.5 + t * 0.3;
  }

  animateFlick() {
    this.torso.rotation.x = -0.35;
    this.rightThigh.rotation.x = 0.8;
    this.rightCalf.rotation.x = -1.2;
    this.leftThigh.rotation.x = -0.4;
  }

  animateBicycle() {
    // Airborne backflip pose
    this.torso.rotation.x = THREE.MathUtils.lerp(this.torso.rotation.x, -Math.PI * 0.7, 0.2);
    this.rightThigh.rotation.x = -1.4;
    this.leftThigh.rotation.x = 0.6;
  }

  animateJuggle() {
    const c = this.animTime * 7;
    this.torso.position.y = THREE.MathUtils.lerp(this.torso.position.y, Math.abs(Math.sin(c)) * 0.05, 0.4);
    this.torso.rotation.set(0.06, 0, 0);

    this.leftThigh.rotation.x = -Math.max(0, Math.sin(c)) * 0.7;
    this.rightThigh.rotation.x = -Math.max(0, -Math.sin(c)) * 0.7;
    this.leftCalf.rotation.x = -Math.max(0, Math.sin(c)) * 0.5;
    this.rightCalf.rotation.x = -Math.max(0, -Math.sin(c)) * 0.5;

    this.setLimb(this.leftShoulder, 'z', 0.5, 0.2);
    this.setLimb(this.rightShoulder, 'z', -0.5, 0.2);
    this.leftShoulder.rotation.x = Math.sin(c) * 0.2;
    this.rightShoulder.rotation.x = -Math.sin(c) * 0.2;
    this.head.rotation.x = THREE.MathUtils.lerp(this.head.rotation.x, 0.22, 0.2);
    this.lean = this.pitch = 0;
  }

  setJumpBend(factor) {
    this.jumpBend = factor;
  }
}
