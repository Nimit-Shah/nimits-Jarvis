// Reusable material registry. One material instance is shared across meshes so
// draw calls and VRAM stay low, and disposal is centralized.
import { COLORS } from './config.js';

/**
 * Builds the shared material set for a given THREE namespace.
 * Materials are created lazily and cached for the lifetime of the renderer.
 */
export const createMaterialRegistry = (THREE) => {
  const registry = new Map();

  const define = (key, factory) => {
    Object.defineProperty(api, key, {
      enumerable: true,
      get() {
        if (!registry.has(key)) registry.set(key, factory());
        return registry.get(key);
      }
    });
  };

  const api = {
    /** Warm matte plaster — stage, plinth, seating blocks. */
    plasterMat: null,
    /** Deep espresso drape fabric. */
    fabricMat: null,
    /** Warm dark backdrop wall behind the arch. */
    backdropMat: null,
    /** Restrained brass trim (metalness kept under 0.4). */
    brassMat: null,
    /** Emissive diya / string-light material. */
    emberMat: null,
    /** Matte ground plane. */
    groundMat: null,
    /** Dark timber stage deck. */
    woodMat: null,
    /** Polished luxury venue floor with subtle specular reflectivity. */
    polishedFloorMat: null,
    /** Deep velvet burgundy fabric for drapes and runners. */
    burgundyFabricMat: null,
    /** Warm champagne floral petals and arrangements. */
    champagneFloralMat: null,
    /** Rich burgundy floral petals. */
    burgundyFloralMat: null,
    /** Hanging fairy light canopy and warm amber pendants. */
    hangingLightMat: null,
    /** Warm ivory/champagne stage plinth material. */
    stageMarbleMat: null,
    dispose() {
      for (const material of registry.values()) {
        if (material && typeof material.dispose === 'function') material.dispose();
      }
      registry.clear();
    }
  };

  define('plasterMat', () =>
    // Warm stone rather than pure ivory — reads as a lit mandap at night.
    new THREE.MeshStandardMaterial({ color: 0x8f867a, roughness: 0.9, metalness: 0 })
  );
  define('fabricMat', () =>
    new THREE.MeshStandardMaterial({
      color: 0x33291f,
      roughness: 0.98,
      metalness: 0,
      side: THREE.DoubleSide
    })
  );
  define('backdropMat', () =>
    new THREE.MeshStandardMaterial({
      color: 0x241d17,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide
    })
  );
  define('brassMat', () =>
    new THREE.MeshStandardMaterial({ color: COLORS.gold, roughness: 0.36, metalness: 0.45 })
  );
  define('emberMat', () =>
    new THREE.MeshStandardMaterial({
      color: COLORS.marigold,
      emissive: COLORS.marigold,
      emissiveIntensity: 1.2,
      roughness: 0.8,
      metalness: 0
    })
  );
  define('groundMat', () =>
    new THREE.MeshStandardMaterial({ color: COLORS.ink, roughness: 1, metalness: 0 })
  );
  define('woodMat', () =>
    // Near-black timber deck. Deliberately dark so warm light pools read as
    // lighting, not as a flat amber slab across the frame.
    new THREE.MeshStandardMaterial({ color: 0x171310, roughness: 0.95, metalness: 0 })
  );
  define('polishedFloorMat', () =>
    // High-end satin polished noir floor catching soft specular highlights from stage & fairy lights
    new THREE.MeshStandardMaterial({
      color: 0x120e0b,
      roughness: 0.18,
      metalness: 0.25,
      envMapIntensity: 0.6
    })
  );
  define('burgundyFabricMat', () =>
    new THREE.MeshStandardMaterial({
      color: COLORS.burgundy,
      roughness: 0.94,
      metalness: 0.04,
      side: THREE.DoubleSide
    })
  );
  define('champagneFloralMat', () =>
    new THREE.MeshStandardMaterial({
      color: COLORS.champagne,
      roughness: 0.78,
      metalness: 0
    })
  );
  define('burgundyFloralMat', () =>
    new THREE.MeshStandardMaterial({
      color: COLORS.burgundy,
      roughness: 0.82,
      metalness: 0
    })
  );
  define('hangingLightMat', () =>
    new THREE.MeshStandardMaterial({
      color: COLORS.warmGlow,
      emissive: COLORS.warmGlow,
      emissiveIntensity: 2.2,
      roughness: 0.3,
      metalness: 0.2
    })
  );
  define('stageMarbleMat', () =>
    new THREE.MeshStandardMaterial({
      color: 0xd6ccbe,
      roughness: 0.4,
      metalness: 0.08
    })
  );

  return api;
};
