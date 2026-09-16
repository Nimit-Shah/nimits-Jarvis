// One camera, one control surface. Chapter transitions move the DollyRig;
// scenes never create their own camera.
import { CAMERA } from './config.js';
import { clamp, dampVec3, samplePath } from './utils/animation.js';

export class CameraController {
  constructor(THREE, { reducedMotion = false } = {}) {
    this.THREE = THREE;
    this.reducedMotion = reducedMotion;
    this.camera = new THREE.PerspectiveCamera(
      CAMERA.fov,
      window.innerWidth / window.innerHeight,
      CAMERA.near,
      CAMERA.far
    );
    this.camera.position.set(CAMERA.start.x, CAMERA.start.y, CAMERA.start.z);

    this.lookAt = new THREE.Vector3(CAMERA.lookAt.x, CAMERA.lookAt.y, CAMERA.lookAt.z);
    this.targetPosition = new THREE.Vector3().copy(this.camera.position);
    this.parallax = new THREE.Vector2(0, 0);
    this.dollyStrength = reducedMotion ? 0 : 1;

    this.camera.lookAt(this.lookAt);
  }

  setReducedMotion(reduced) {
    this.reducedMotion = reduced;
    this.dollyStrength = reduced ? 0 : 1;
  }

  /** globalProgress: 0..1 across the whole venue walk. */
  setScrollProgress(globalProgress) {
    const point = samplePath(CAMERA.dolly, clamp(globalProgress));
    this.targetPosition.set(point.x, point.y, point.z);
    if (this.reducedMotion) this.camera.position.copy(this.targetPosition);
  }

  /** Normalized pointer offset for gentle parallax, supplied by InteractionManager. */
  setParallax(x, y) {
    this.parallax.set(x, y);
  }

  update(dt) {
    dampVec3(this.camera.position, this.targetPosition, this.reducedMotion ? 60 : 2.4, dt);

    if (!this.reducedMotion && this.dollyStrength > 0) {
      this.camera.position.x += this.parallax.x * 0.18;
      this.camera.position.y += this.parallax.y * 0.08;
    }

    this.camera.lookAt(this.lookAt);
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.camera.clear?.();
  }
}
