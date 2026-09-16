// Pointer interaction only — deliberately no orbit controls.
// Normalized, damped, and fully disabled for reduced motion / touch / low power.
export class InteractionManager {
  constructor({ onParallax, reducedMotion = false, enabled = true } = {}) {
    this.onParallax = onParallax || (() => {});
    this.reducedMotion = reducedMotion;
    this.enabled = enabled;
    this.target = { x: 0, y: 0 };
    this.current = { x: 0, y: 0 };

    this.handlePointerMove = (event) => {
      if (!this.enabled || this.reducedMotion) return;
      const x = (event.clientX / window.innerWidth) * 2 - 1;
      const y = (event.clientY / window.innerHeight) * 2 - 1;
      this.target.x = x;
      this.target.y = -y;
    };
    this.handlePointerLeave = () => {
      this.target.x = 0;
      this.target.y = 0;
    };
  }

  init() {
    const supportsHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (supportsHover) {
      window.addEventListener('pointermove', this.handlePointerMove, { passive: true });
      window.addEventListener('pointerleave', this.handlePointerLeave, { passive: true });
    }
    return this;
  }

  setReducedMotion(reduced) {
    this.reducedMotion = reduced;
    if (reduced) {
      this.target.x = 0;
      this.target.y = 0;
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.target.x = 0;
      this.target.y = 0;
    }
  }

  /** Called each frame; emits damped values so camera motion never snaps. */
  update(dt) {
    const lambda = 3.2;
    const factor = 1 - Math.exp(-lambda * dt);
    this.current.x += (this.target.x - this.current.x) * factor;
    this.current.y += (this.target.y - this.current.y) * factor;
    this.onParallax(this.current.x, this.current.y);
  }

  dispose() {
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerleave', this.handlePointerLeave);
  }
}
