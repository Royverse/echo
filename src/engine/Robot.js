// Procedural robot, fully rigged from primitives. The animation is driven by the
// engine's locomotion state (speed + turn rate) so the gait always matches the
// real ground speed — walk and run emerge from one blended cycle, no foot slide.
import * as THREE from 'three';

export class Robot {
  constructor() {
    this.mesh = new THREE.Group();

    // Transient expressive poses set by the engine: 'none' | 'wave' | 'dance'.
    this.pose = 'none';
    this.airborne = false;

    this.animTime = 0;
    this.gaitPhase = 0;       // advances with distance travelled -> no sliding
    this.jumpBend = 0;        // 0 standing .. 1 crouched (engine-driven)
    this.lean = 0;            // smoothed bank angle
    this.pitch = 0;           // smoothed forward lean

    this.defaultHeight = 1.6;
    this.walkSpeed = 3.0;     // speed above which the run blend kicks in

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

    // chest beveled plate
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.05), trimMat);
    plate.position.set(0, 0.05, 0.31);
    this.torso.add(plate);

    // Glowing core + a soft point light for a believable self-lit glow
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
      this.torso.add(shoulder);
      shoulder.add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 14), trimMat));
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.35, 10), metalMat);
      upper.position.set(0, -0.18, 0);
      upper.castShadow = true;
      shoulder.add(upper);

      const elbow = new THREE.Group();
      elbow.position.set(0, -0.36, 0);
      shoulder.add(elbow);
      elbow.add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 10), trimMat));
      const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.3, 10), metalMat);
      lower.position.set(0, -0.15, 0);
      lower.castShadow = true;
      elbow.add(lower);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.11), trimMat);
      hand.position.set(0, -0.33, 0);
      elbow.add(hand);
      return { shoulder, elbow };
    };
    const right = buildArm(-1);
    const left = buildArm(1);
    this.rightShoulder = right.shoulder; this.rightElbow = right.elbow;
    this.leftShoulder = left.shoulder; this.leftElbow = left.elbow;

    // Legs
    const buildLeg = (side) => {
      const thigh = new THREE.Group();
      thigh.position.set(0.25 * side, -0.55, 0);
      this.torso.add(thigh);
      const hip = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 10), trimMat);
      hip.rotation.z = Math.PI / 2;
      thigh.add(hip);
      const thighMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.08, 0.45, 10), metalMat);
      thighMesh.position.set(0, -0.22, 0);
      thighMesh.castShadow = true;
      thigh.add(thighMesh);

      const calf = new THREE.Group();
      calf.position.set(0, -0.45, 0);
      thigh.add(calf);
      calf.add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), trimMat));
      const calfMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.4, 10), metalMat);
      calfMesh.position.set(0, -0.2, 0);
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

  /**
   * @param {number} dt
   * @param {{speed:number, turnRate:number, maxSpeed:number, airborne:boolean}} motion
   * @returns {boolean} true on the frame a footfall lands (engine plays the sound)
   */
  update(dt, motion = {}) {
    const { speed = 0, turnRate = 0, maxSpeed = 6, airborne = false } = motion;
    this.animTime += dt;
    this.airborne = airborne;

    // Occasional blink.
    const blink = Math.sin(this.animTime * 0.7) > 0.985 ? 0.12 : 1;
    this.eyeL.scale.y = blink;
    this.eyeR.scale.y = blink;

    if (this.pose === 'dance') { this.animateDance(); return false; }
    if (this.pose === 'wave') { this.animateWave(speed); return false; }

    return this.animateLocomotion(dt, speed, turnRate, maxSpeed, airborne);
  }

  animateLocomotion(dt, speed, turnRate, maxSpeed, airborne) {
    const absSpeed = Math.abs(speed);
    const move = THREE.MathUtils.clamp(absSpeed / (maxSpeed * 0.45), 0, 1);
    const run = THREE.MathUtils.clamp((absSpeed - this.walkSpeed) / Math.max(0.1, maxSpeed - this.walkSpeed), 0, 1);
    const sign = speed < 0 ? -1 : 1;

    // Advance the gait by distance travelled so feet track the ground.
    const prevPhase = this.gaitPhase;
    this.gaitPhase += absSpeed * 1.7 * dt;
    const cycle = this.gaitPhase * sign;

    // Smooth body lean: bank into turns, pitch forward with speed.
    const targetLean = THREE.MathUtils.clamp(-turnRate * 0.18 * (0.4 + move), -0.35, 0.35);
    const targetPitch = move * sign * (0.06 + run * 0.12);
    this.lean = THREE.MathUtils.lerp(this.lean, targetLean, 0.12);
    this.pitch = THREE.MathUtils.lerp(this.pitch, targetPitch, 0.1);

    const swing = (0.25 + run * 0.45) * move;        // leg amplitude
    const armSwing = (0.2 + run * 0.5) * move;
    const bobAmp = (0.04 + run * 0.06) * move;

    // Torso
    this.torso.position.y = THREE.MathUtils.lerp(this.torso.position.y, Math.abs(Math.sin(cycle)) * bobAmp - bobAmp * 0.5, 0.4);
    this.torso.rotation.z = this.lean;
    this.torso.rotation.x = this.pitch;
    this.torso.rotation.y = THREE.MathUtils.lerp(this.torso.rotation.y, Math.sin(cycle) * 0.04 * move, 0.3);
    this.head.rotation.y = THREE.MathUtils.lerp(this.head.rotation.y, -Math.sin(cycle) * 0.03 * move - turnRate * 0.05, 0.2);
    this.head.rotation.z = -this.lean * 0.5;

    // Idle breathing folded in when nearly still.
    const breath = Math.sin(this.animTime * 1.6) * (1 - move);

    if (airborne) {
      // Tuck for the jump arc.
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

    // Legs swing in counterphase; knees bend backwards on the back swing only (negative rotation)
    this.rightThigh.rotation.x = Math.sin(cycle) * swing + this.jumpBend * 0.5;
    this.leftThigh.rotation.x = -Math.sin(cycle) * swing + this.jumpBend * 0.5;
    const kr = Math.sin(cycle - Math.PI / 3);
    const kl = Math.sin(cycle + Math.PI / 3);
    this.rightCalf.rotation.x = (kr > 0 ? -kr * (0.4 + run * 0.4) : 0) - this.jumpBend * 0.7;
    this.leftCalf.rotation.x = (kl > 0 ? -kl * (0.4 + run * 0.4) : 0) - this.jumpBend * 0.7;

    // Arms counter-swing; settle to a relaxed idle when still.
    this.leftShoulder.rotation.x = -Math.sin(cycle) * armSwing + breath * 0.05;
    this.rightShoulder.rotation.x = Math.sin(cycle) * armSwing + breath * 0.05;
    this.leftShoulder.rotation.z = THREE.MathUtils.lerp(this.leftShoulder.rotation.z, 0.16 + run * 0.1, 0.2);
    this.rightShoulder.rotation.z = THREE.MathUtils.lerp(this.rightShoulder.rotation.z, -0.16 - run * 0.1, 0.2);
    this.leftElbow.rotation.x = -0.2 - Math.abs(Math.sin(cycle)) * (0.2 + run * 0.3);
    this.rightElbow.rotation.x = -0.2 - Math.abs(Math.cos(cycle)) * (0.2 + run * 0.3);

    // Footfall detection: trigger when a foot passes the bottom of its arc.
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
    // Settle lower body to standing.
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

  setJumpBend(factor) {
    this.jumpBend = factor;
  }
}
