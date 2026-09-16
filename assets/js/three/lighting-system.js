// Centralized lighting. One rig, dimmed per chapter — no per-scene light setup.
import { COLORS, FOG } from './config.js';
import { damp } from './utils/animation.js';

export class LightingSystem {
  constructor(THREE, scene) {
    this.THREE = THREE;
    this.scene = scene;
    this.lights = [];
    this.profiles = new Map();
    this.enabled = true;

    scene.fog = new THREE.Fog(FOG.color, FOG.near, FOG.far);
    scene.background = new THREE.Color(COLORS.ink);

    this.hemi = new THREE.HemisphereLight(COLORS.sand, COLORS.ink, 0.16);
    this.ambient = new THREE.AmbientLight(COLORS.charcoal, 0.2);

    // Warm 2700K key light — a tight pool over the stage. Short range keeps the
    // deck and ground dark so the brass arch and diyas stay the focal points.
    this.key = new THREE.PointLight(COLORS.marigold, 12, 11, 2);
    this.key.position.set(0, 4.0, 0.2);

    // Cool moon rim for separation.
    this.rim = new THREE.DirectionalLight(0x8fa6c8, 0.3);
    this.rim.position.set(-4, 6, -6);

    // Low, wide fill so seating rows read without lifting the ground.
    this.fill = new THREE.PointLight(COLORS.gold, 3, 16, 2);
    this.fill.position.set(3.4, 2.4, 3.2);

    // Warm champagne architectural uplight for polished floor specular reflections
    this.uplight = new THREE.PointLight(COLORS.champagne, 4.5, 9, 2);
    this.uplight.position.set(0, 0.45, 2.8);

    this.lights.push(this.hemi, this.ambient, this.key, this.rim, this.fill, this.uplight);
    for (const light of this.lights) scene.add(light);

    this.registerProfile('default', { hemi: 0.14, ambient: 0.18, key: 12, rim: 0.3, fill: 3, uplight: 4.5 });
    this.registerProfile('entrance', { hemi: 0.11, ambient: 0.15, key: 9, rim: 0.24, fill: 2.4, uplight: 3.5 });
    this.registerProfile('stage', { hemi: 0.17, ambient: 0.21, key: 15, rim: 0.34, fill: 3.6, uplight: 5.5 });
    this.registerProfile('seating', { hemi: 0.13, ambient: 0.17, key: 11, rim: 0.28, fill: 4.2, uplight: 3.8 });
    this.registerProfile('buffet', { hemi: 0.14, ambient: 0.18, key: 12, rim: 0.25, fill: 4.6, uplight: 3.0 });
    this.registerProfile('stations', { hemi: 0.12, ambient: 0.16, key: 13, rim: 0.28, fill: 3, uplight: 3.2 });
    this.registerProfile('gallery', { hemi: 0.18, ambient: 0.22, key: 14, rim: 0.32, fill: 3.4, uplight: 3.6 });
    this.registerProfile('stories', { hemi: 0.12, ambient: 0.16, key: 11, rim: 0.3, fill: 2.6, uplight: 2.8 });
    this.registerProfile('dancefloor', { hemi: 0.11, ambient: 0.14, key: 16, rim: 0.42, fill: 4, uplight: 5.0 });

    this.targetProfile = this.profiles.get('default');
  }

  registerProfile(name, profile) {
    this.profiles.set(name, profile);
  }

  applyProfile(name, sharp = false) {
    const target = this.profiles.get(name) || this.profiles.get('default');
    if (!target) return;
    this.targetProfile = target;

    if (sharp) {
      this.hemi.intensity = target.hemi;
      this.ambient.intensity = target.ambient;
      this.key.intensity = target.key;
      this.rim.intensity = target.rim;
      this.fill.intensity = target.fill;
      if (target.uplight !== undefined) this.uplight.intensity = target.uplight;
    }
  }

  update(dt) {
    if (!this.targetProfile || !dt) return;
    const lambda = 4.0;
    this.hemi.intensity = damp(this.hemi.intensity, this.targetProfile.hemi, lambda, dt);
    this.ambient.intensity = damp(this.ambient.intensity, this.targetProfile.ambient, lambda, dt);
    this.key.intensity = damp(this.key.intensity, this.targetProfile.key, lambda, dt);
    this.rim.intensity = damp(this.rim.intensity, this.targetProfile.rim, lambda, dt);
    this.fill.intensity = damp(this.fill.intensity, this.targetProfile.fill, lambda, dt);
    if (this.targetProfile.uplight !== undefined) {
      this.uplight.intensity = damp(this.uplight.intensity, this.targetProfile.uplight, lambda, dt);
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    for (const light of this.lights) light.visible = enabled;
  }

  dispose() {
    for (const light of this.lights) {
      light.dispose?.();
      light.parent?.remove(light);
    }
    this.lights.length = 0;
    this.profiles.clear();
    this.scene.fog = null;
  }
}
