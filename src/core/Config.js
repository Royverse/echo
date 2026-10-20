// Central configuration for ECHO. All physics, locomotion, football,
// opponent, goalkeeper, and audio parameters are centralized here.

export const Config = {
  ARENA: {
    RADIUS: 26,
    WALL_MARGIN: 0.8,
  },

  PHYSICS: {
    FIXED_DT: 1 / 120,          // 120Hz deterministic physics
    MAX_SUB_STEPS: 16,          // allows catching up under low headless frame rates
    GRAVITY: 24,                // matches ball & jump gravity
    JUMP_VELOCITY: 9.2,
    BALL_RADIUS: 0.36,
    BALL_RESTITUTION: 0.55,
    BALL_ROLL_FRICTION: 0.9,    // horizontal damping while rolling (/s, exp)
    BALL_AIR_DRAG: 0.16,        // horizontal damping while airborne
    BALL_MAGNUS: 1.15,          // sideways curve acceleration factor
    BALL_SPIN_DECAY: 0.6,       // spin bleeds off over time
    BALL_STOP_SPEED: 0.06,      // velocity cutoff for resting ball
  },

  ROBOT: {
    WALK_SPEED: 3.2,
    RUN_SPEED: 7.0,
    ACCEL: 14,
    BRAKE: 16,
    TURN_RATE: 2.6,             // rad/s
    TURN_ACCEL: 12,
    STEP_SIZE: 1.6,
    DEFAULT_MOVE_STEPS: 5,
    CONTROL_NEAR: 0.7,          // ball offset at walk
    CONTROL_FAR: 1.7,           // ball offset at run
    CONTROL_RADIUS: 1.4,        // loose ball pickup distance
    CONTROL_SPEED: 7.0,         // max speed to trap loose ball
    CONTROL_STIFFNESS: 10,      // spring stiffness for ball carrying
    STRIKE_RANGE: 1.6,
    KICK_CONTACT: 0.5,          // normalized contact time of 0.7s clip
    KICK_DURATION: 0.7,
    MOMENTUM_INHERITANCE: 0.25, // ballVel += robotVel * 0.25
    KICK_POWER: { tap: 5, pass: 9, drive: 14, blast: 21 },
    KICK_LOFT: { ground: 0, low: 2.6, lofted: 7.5, chip: 9 },
    SHOT_SPEED: { tap: 10, pass: 13, drive: 18, blast: 24 },
    KICK_SPIN: 0.34,
    AIM_OFFSET: 0.22,           // ~13 degrees aim nudge
  },

  GOAL: {
    W: 7.0,
    H: 2.7,
    Z: 23.0,                    // ARENA.RADIUS - 3
    ATTACK_Z: 23.0,
    DEFEND_Z: -23.0,
  },

  DEFENDER: {
    SPEED: 4.6,
    PRESSURE_RANGE: 3.0,
    TACKLE_RANGE: 1.4,
    LUNGE_TIME: 0.32,
    TACKLE_COOLDOWN: 1.1,
    RECOVER_LOCKOUT: 0.9,
    JOCKEY_DIST: 2.4,
  },

  KEEPER: {
    TRACK_SPEED: 4.2,
    TRACK_BIAS: 0.8,
    DIVE_REACH: 1.5,
    DIVE_SPEED: 9.0,
    CATCH: 0.9,
    DIVE_TIME: 0.55,
    RUSH_SPEED: 5.5,
    RECOVER_TIME: 0.6,
  },

  JUICE: {
    HIT_STOP_DRIVE: 35,         // ms
    HIT_STOP_BLAST: 80,         // ms
    HIT_STOP_SAVE: 50,          // ms
    HIT_STOP_WOODWORK: 55,      // ms
    SLOW_MO_BLAST: 0.35,
    SLOW_MO_BLAST_MS: 120,
    CAMERA_TRAUMA_DECAY: 1.4,
    CAMERA_MAX_SHAKE: 0.45,
    FOV_PUNCH_BLAST: 3.0,       // deg
  },

  AUDIO: {
    MASTER_GAIN: 0.9,
    EARCON_DURATION: 0.06,
    DUCKING_DB: -12,
  },
};
