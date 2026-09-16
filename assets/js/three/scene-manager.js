// SceneManager — single persistent renderer, single scene graph, single loop.
// Scenes are registered as definitions and mounted/unmounted through a
// lifecycle contract so geometry, materials and textures always get disposed.
import { CAMERA, COLORS, LIMITS } from './config.js';
import { PerformanceManager, QUALITY } from './performance-manager.js';
import { CameraController } from './camera-controller.js';
import { LightingSystem } from './lighting-system.js';
import { AssetLoader } from './asset-loader.js';
import { ScrollController } from './scroll-controller.js';
import { InteractionManager } from './interaction-manager.js';
import { createMaterialRegistry } from './materials.js';

let instance = null;

export class SceneManager {
  constructor() {
    if (instance) return instance;
    instance = this;

    this.initialized = false;
    this.canvas = null;
    this.THREE = null;
    this.definitions = new Map();
    this.activeScene = null;
    this.activeSceneName = null;
    this.extras = new Set();
    this.frameRate = { last: 0, acc: 0 };
    this.resizeObserver = null;

    this.performance = new PerformanceManager({
      onQualityChange: (quality) => this.applyQuality(quality),
      onMotionPreferenceChange: (reduced) => this.applyMotionPreference(reduced)
    });

    this.handleResize = this.handleResize.bind(this);
    this.tick = this.tick.bind(this);
  }

  static get instance() {
    return instance;
  }

  /** Boots the persistent WebGL context. Safe to call once per document. */
  async init({ THREE, canvas, sceneDefinitions = [] }) {
    if (this.initialized) return this;

    const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!context) throw new Error('SceneManager: WebGL is not available in this browser');

    this.THREE = THREE;
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context,
      antialias: true, // construction-time only; never toggle after this
      alpha: true,
      powerPreference: 'high-performance',
      stencil: false
    });
    THREE.ColorManagement.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // Opaque night clear so the venue reads as a real room, not a milky overlay.
    this.renderer.setClearColor(COLORS.ink, 1);

    this.scene = new THREE.Scene();
    this.materials = createMaterialRegistry(THREE);
    this.assets = new AssetLoader(THREE);
    this.lighting = new LightingSystem(THREE, this.scene);
    this.cameraController = new CameraController(THREE, {
      reducedMotion: this.performance.reducedMotion
    });
    this.camera = this.cameraController.camera;

    this.scroll = new ScrollController({
      reducedMotion: this.performance.reducedMotion,
      onProgress: (progress) => this.cameraController.setScrollProgress(progress),
      onChapter: (index, id) => this.applyChapter(index, id)
    }).init();

    this.interaction = new InteractionManager({
      reducedMotion: this.performance.reducedMotion,
      onParallax: (x, y) => this.cameraController.setParallax(x, y)
    }).init();

    for (const definition of sceneDefinitions) this.register(definition);

    this.handleResize();
    window.addEventListener('resize', this.handleResize, { passive: true });
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(document.documentElement);
    }

    this.performance.onVisibility((visible) => this.setPaused(!visible));
    this.initialized = true;
    return this;
  }

  /** Registers a scene definition: { name, build(ctx), chapter? } */
  register(definition) {
    if (!definition || !definition.name) throw new Error('SceneManager: definition needs a name');
    this.definitions.set(definition.name, definition);
    return this;
  }

  /** Mounts a scene, disposing whatever was active before. */
  mount(name, chapterId = 'entrance') {
    const definition = this.definitions.get(name);
    if (!definition) {
      console.warn(`SceneManager: no scene registered as "${name}"`);
      return null;
    }
    if (this.activeSceneName === name) return this.activeScene;

    this.unmount();
    const built = definition.build({
      THREE: this.THREE,
      materials: this.materials,
      assets: this.assets,
      quality: this.performance.quality,
      reducedMotion: this.performance.reducedMotion
    });

    const group = built.group || built;
    this.scene.add(group);
    this.activeScene = { name, definition, built, group, chapterId };
    this.activeSceneName = name;
    this.scene.dispatchEvent?.({ type: 'scene-mounted', name });
    return this.activeScene;
  }

  unmount() {
    if (!this.activeScene) return;
    const { built, group } = this.activeScene;
    if (typeof built.dispose === 'function') built.dispose();
    this.scene.remove(group);
    this.activeScene = null;
    this.activeSceneName = null;
  }

  applyChapter(index, id) {
    this.lighting.applyProfile(id, this.performance.reducedMotion);
    const scene = this.activeScene;
    if (scene && typeof scene.built.onChapter === 'function') scene.built.onChapter(index, id);
    if (this.performance.reducedMotion) this.render();
  }

  /** Extra per-frame hooks (future overlays, transitions). */
  addExtra(fn) {
    this.extras.add(fn);
    return () => this.extras.delete(fn);
  }

  applyQuality(quality) {
    this.renderer.setPixelRatio(this.performance.dpr);
    this.handleResize();
    if (this.activeSceneName === 'wedding-stage' && quality !== QUALITY.HIGH) {
      // Rebuild at the new density so particle/seat counts follow quality.
      const name = this.activeSceneName;
      this.activeSceneName = null;
      this.mount(name);
    }
  }

  applyMotionPreference(reduced) {
    this.cameraController.setReducedMotion(reduced);
    this.interaction.setReducedMotion(reduced);
    this.scroll.reducedMotion = reduced;
    if (reduced) {
      this.renderer.setAnimationLoop(null);
      this.cameraController.setScrollProgress(this.scroll.progress);
      this.render();
    } else if (!this.paused) {
      this.start();
    }
  }

  setPaused(paused) {
    this.paused = paused;
    if (paused || this.performance.reducedMotion) {
      this.renderer.setAnimationLoop(null);
    } else {
      this.start();
    }
  }

  handleResize() {
    if (!this.renderer || !this.canvas) return;
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    if (width === 0 || height === 0) return;
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;

    this.renderer.setPixelRatio(this.performance.dpr);
    this.renderer.setSize(width, height, false);
    this.cameraController.resize(width, height);
    this.scroll.measure();
    if (this.performance.reducedMotion) this.render();
  }

  start() {
    if (!this.initialized || this.performance.reducedMotion) return;
    if (!this.timer) {
      this.timer = new this.THREE.Timer();
      this.timer.connect(document); // avoids huge deltas after tab restore
    }
    this.renderer.setAnimationLoop(this.tick); // display-synced; auto-pauses on hidden tab
  }

  tick(now) {
    this.timer.update(now);
    const rawDt = this.timer.getDelta();
    const dt = Number.isFinite(rawDt) && rawDt > 0 ? Math.min(rawDt, LIMITS.maxDelta) : 0;
    const elapsed = this.timer.getElapsed();

    this.performance.sample(dt, now);

    if (this.performance.animates) {
      this.lighting.update(dt);
      this.interaction.update(dt);
      if (this.activeScene && typeof this.activeScene.built.update === 'function') {
        this.activeScene.built.update(dt, elapsed);
      }
      for (const extra of this.extras) extra(dt, elapsed);
    }

    this.cameraController.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  render() {
    if (!this.initialized) return;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer?.setAnimationLoop(null);
    window.removeEventListener('resize', this.handleResize);
    this.resizeObserver?.disconnect();
    this.unmount();
    this.scroll?.dispose();
    this.interaction?.dispose();
    this.performance?.dispose();
    this.lighting?.dispose();
    this.assets?.dispose();
    this.materials?.dispose();
    this.extras.clear();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
    this.definitions.clear();
    this.initialized = false;
    if (instance === this) instance = null;
  }
}

export const getSceneManager = () => instance;
