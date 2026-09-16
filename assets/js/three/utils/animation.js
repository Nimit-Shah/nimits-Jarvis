// Reusable animation utilities. No GSAP dependency so this stays bundle-free.
export const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));

export const lerp = (a, b, t) => a + (b - a) * t;

// Frame-rate independent damp (exponential smoothing).
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export const dampVec3 = (current, target, lambda, dt) => {
  current.x = damp(current.x, target.x, lambda, dt);
  current.y = damp(current.y, target.y, lambda, dt);
  current.z = damp(current.z, target.z, lambda, dt);
  return current;
};

export const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Maps global scroll progress to a position along a chapter dolly path.
export const samplePath = (points, progress) => {
  if (points.length === 0) return { x: 0, y: 0, z: 0 };
  if (points.length === 1) return { ...points[0] };
  const scaled = clamp(progress) * (points.length - 1);
  const i = Math.min(Math.floor(scaled), points.length - 2);
  const t = easeInOutCubic(scaled - i);
  const a = points[i];
  const b = points[i + 1];
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
};

// Small reusable pulsing helper for emissive embers / diyas.
export const pulse = (time, speed = 1, min = 0.6, max = 1) =>
  lerp(min, max, (Math.sin(time * speed) + 1) / 2);
