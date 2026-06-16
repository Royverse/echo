// Procedural goalkeeper: shuffles along his line to track the ball, then commits
// a dive at a struck shot. He predicts a *straight-line* intercept and can only
// reach so far from where he set himself — so corners and curl (which deviates
// from the prediction) beat him, while shots near him are saved. Asset-free, in
// the spirit of Robot.js but much simpler.
import * as THREE from 'three';

const GRAVITY = 24;            // must match Ball.js for intercept prediction
const TRACK_SPEED = 4.2;       // shuffle speed along the goal line
const TRACK_BIAS = 0.8;        // how far toward the ball's x he commits (1 = fully)
const DIVE_REACH = 1.5;        // how far from his set x he can stretch on a dive
const DIVE_SPEED = 9;          // how fast the hands travel to the dive point
const CATCH = 0.9;             // hands within this of the ball (x,y) = save
const DIVE_TIME = 0.55;

export class Goalkeeper {
  constructor(goal) {
    this.goal = goal;
    this.homeZ = goal.z - 0.6;        // stands just off his line
    this.half = goal.w / 2 - 0.5;     // how far along the line he roams
    this.x = 0;
    this.reachY = 1.0;
    this.committed = false;
    this.diveT = 0;
    this.setX = 0; this.divePredX = 0; this.divePredY = 1.0; this.diveDir = 0;
    this.reachPoint = new THREE.Vector3(0, 1.0, this.homeZ);
    this.CATCH = CATCH;

    this.mesh = new THREE.Group();
    this.build();
    this.mesh.position.set(0, 0, this.homeZ);
  }

  build() {
    const kit = new THREE.MeshStandardMaterial({ color: 0x2fe08a, roughness: 0.5, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14361f, roughness: 0.6 });
    const glove = new THREE.MeshStandardMaterial({ color: 0xffe14d, emissive: 0xffe14d, emissiveIntensity: 0.25, roughness: 0.4 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xcf9b6a, roughness: 0.6 });

    this.body = new THREE.Group();    // inner group we lean/translate for dives
    this.mesh.add(this.body);

    const legGeo = new THREE.BoxGeometry(0.22, 0.7, 0.24);
    this.legL = new THREE.Mesh(legGeo, dark); this.legL.position.set(-0.16, 0.35, 0); this.legL.castShadow = true; this.body.add(this.legL);
    this.legR = this.legL.clone(); this.legR.position.x = 0.16; this.body.add(this.legR);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.34), kit);
    torso.position.y = 1.1; torso.castShadow = true; this.body.add(torso);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), skin);
    head.position.y = 1.72; head.castShadow = true; this.body.add(head);
    this.head = head;

    const buildArm = (side) => {
      const arm = new THREE.Group();
      arm.position.set(0.34 * side, 1.42, 0);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.52, 0.15), kit);
      upper.position.y = -0.26; upper.castShadow = true; arm.add(upper);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), glove);
      hand.position.y = -0.56; arm.add(hand);
      this.body.add(arm);
      return arm;
    };
    this.armL = buildArm(-1);
    this.armR = buildArm(1);
    this.armL.rotation.z = 0.35;       // ready stance: arms out
    this.armR.rotation.z = -0.35;
  }

  reset() {
    this.committed = false;
    this.diveT = 0;
    this.x = 0;
    this.mesh.position.x = 0;
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
  }

  onSave() {
    // a quick recovery after parrying
    this.committed = false;
    this.diveT = 0.2;
  }

  update(dt, ctx) {
    const ball = ctx.ball;
    const b = ball.position;

    if (!this.committed) {
      // Track the ball's x along the line (with a central bias).
      const desired = THREE.MathUtils.clamp(b.x * TRACK_BIAS, -this.half, this.half);
      this.x += THREE.MathUtils.clamp(desired - this.x, -TRACK_SPEED * dt, TRACK_SPEED * dt);
      this.reachY += (1.0 - this.reachY) * Math.min(1, dt * 6);

      // Detect a strike heading at goal and commit a dive to the predicted spot.
      const incoming = ball.vel.z > 5 && b.z < this.homeZ - 0.3 && b.z > this.homeZ - 16;
      if (incoming) {
        const tHit = (this.homeZ - b.z) / ball.vel.z;
        const px = b.x + ball.vel.x * tHit;                 // straight-line guess — curl will fool it
        const py = b.y + ball.vel.y * tHit - 0.5 * GRAVITY * tHit * tHit;
        this.setX = this.x;
        this.divePredX = THREE.MathUtils.clamp(px, this.setX - DIVE_REACH, this.setX + DIVE_REACH);
        this.divePredY = THREE.MathUtils.clamp(py, 0.3, 2.4);
        this.diveDir = Math.sign(this.divePredX - this.setX) || 1;
        this.committed = true;
        this.diveT = DIVE_TIME;
      }
    } else {
      this.diveT = Math.max(0, this.diveT - dt);
      this.x += THREE.MathUtils.clamp(this.divePredX - this.x, -DIVE_SPEED * dt, DIVE_SPEED * dt);
      this.reachY += (this.divePredY - this.reachY) * Math.min(1, dt * 10);
      // Recover once the ball is dealt with (gone past, parried away, or stopped).
      if (ball.vel.z < 1 || b.z > this.homeZ + 1.2) { this.committed = false; }
    }

    this.mesh.position.x = this.x;
    this.reachPoint.set(this.x, this.reachY, this.homeZ);
    this.applyPose(dt);
  }

  applyPose(dt) {
    const diving = this.committed && this.diveT > 0;
    const t = diving ? 1 - this.diveT / DIVE_TIME : 0;     // 0..1 dive progress
    const lean = diving ? this.diveDir * 0.9 * t : 0;
    const lift = diving ? -0.25 * t : 0;                   // drops as he goes horizontal
    this.body.rotation.z = THREE.MathUtils.lerp(this.body.rotation.z, lean, 0.3);
    this.body.position.y = THREE.MathUtils.lerp(this.body.position.y, lift, 0.3);
    // Reach both arms toward the ball on a dive; spring back to the ready stance after.
    const high = this.divePredY > 1.4;
    const armUp = diving ? (high ? -2.2 : -0.4) * t : 0;
    this.armL.rotation.x = THREE.MathUtils.lerp(this.armL.rotation.x, armUp, 0.25);
    this.armR.rotation.x = THREE.MathUtils.lerp(this.armR.rotation.x, armUp, 0.25);
    this.armL.rotation.z = THREE.MathUtils.lerp(this.armL.rotation.z, 0.35 + (diving ? this.diveDir * 0.5 : 0), 0.25);
    this.armR.rotation.z = THREE.MathUtils.lerp(this.armR.rotation.z, -0.35 + (diving ? this.diveDir * 0.5 : 0), 0.25);
  }
}
