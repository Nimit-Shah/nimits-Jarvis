// Lazy bootstrap: pulls Three.js and scene modules only when the venue canvas
// enters the viewport, after idle, and only when WebGL is actually usable.
import { VENUE } from './config.js';
import { SceneManager } from './scene-manager.js';

export const isWebGLAvailable = () => {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl'))
    );
  } catch {
    return false;
  }
};

const whenIdle = () =>
  new Promise((resolve) => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(resolve, { timeout: VENUE.idleTimeout });
    } else {
      window.setTimeout(resolve, VENUE.idleTimeout);
    }
  });

const whenVisible = (element) =>
  new Promise((resolve) => {
    if (!('IntersectionObserver' in window)) {
      resolve();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          resolve();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(element);
  });

/**
 * Boots the persistent venue renderer exactly once.
 * @returns {Promise<SceneManager|null>} null when 3D is unavailable and the
 * static (CSS) fallback should remain in charge.
 */
export const bootstrapVenue = async ({ canvas, host } = {}) => {
  const existing = SceneManager.instance;
  if (existing?.initialized) return existing;
  if (!canvas) return null;
  if (!isWebGLAvailable()) {
    document.documentElement.classList.add('no-3d');
    return null;
  }

  await whenVisible(canvas);
  await whenIdle();

  const [THREE, stageModule] = await Promise.all([
    import('three'),
    import('./scenes/wedding-stage.js')
  ]);

  const manager = new SceneManager();
  await manager.init({
    THREE,
    canvas,
    sceneDefinitions: [stageModule.weddingStageScene]
  });

  manager.mount('wedding-stage');

  if (manager.performance.reducedMotion) {
    // Static frame only — no loop, no motion.
    manager.render(0);
  } else {
    manager.start();
  }

  document.documentElement.classList.add('has-3d');
  canvas.dataset.ready = 'true';
  if (host) host.dataset.ready = 'true';
  return manager;
};
