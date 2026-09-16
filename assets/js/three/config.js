// Central numeric + palette config. Mirrors the approved design tokens.
export const COLORS = Object.freeze({
  ivory: 0xf9f5ee,
  champagne: 0xf3e5ab,
  burgundy: 0x58111a,
  deepBurgundy: 0x3d0b12,
  ink: 0x14100c,
  charcoal: 0x1e1a16,
  taupe: 0x8a7f74,
  sand: 0xe8dfd1,
  gold: 0xc2a36b,
  marigold: 0xb7792b,
  warmGlow: 0xffd28e,
  sindoor: 0x7a1e1e
});

export const CAMERA = Object.freeze({
  fov: 38,
  near: 0.1,
  far: 140,
  start: { x: 0, y: 2.7, z: 11.0 },
  lookAt: { x: 0, y: 2.2, z: 0 },
  // Gentle forward push with a slight lateral sway. Raised enough that the
  // stage deck stays in the lower third and never becomes the whole frame.
  dolly: Object.freeze([
    { x: 0, y: 2.7, z: 11.0 }, // 01 entrance
    { x: 0, y: 2.6, z: 9.4 }, // 02 stage
    { x: 1.1, y: 2.5, z: 8.1 }, // 03 seating
    { x: -1.2, y: 2.5, z: 7.2 }, // 04 buffet
    { x: 0.7, y: 2.4, z: 6.5 }, // 05 stations
    { x: -0.8, y: 2.4, z: 5.9 }, // 06 gallery
    { x: 0.5, y: 2.3, z: 5.4 }, // 07 stories
    { x: 0, y: 2.2, z: 4.9 } // 08 dance floor
  ])
});

export const FOG = Object.freeze({ color: COLORS.ink, near: 7, far: 38 });

export const LIMITS = Object.freeze({
  dprMax: 2,
  mobileDprMax: 1.5,
  maxDelta: 0.05,
  minFpsForDowngrade: 40,
  downgradeWindow: 60
});

export const CHAPTERS = Object.freeze([
  { id: 'entrance', index: 0 },
  { id: 'stage', index: 1 },
  { id: 'seating', index: 2 },
  { id: 'buffet', index: 3 },
  { id: 'stations', index: 4 },
  { id: 'gallery', index: 5 },
  { id: 'stories', index: 6 },
  { id: 'dancefloor', index: 7 }
]);

export const MOBILE_BREAKPOINT = 768;

export const VENUE = Object.freeze({
  canvasId: 'sw-venue-canvas',
  reducedMotionQuery: '(prefers-reduced-motion: reduce)',
  idleTimeout: 1200
});
