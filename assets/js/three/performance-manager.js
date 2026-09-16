// Performance + motion preference authority.
// Everything that changes with device capability or accessibility preference
// is decided here, exactly once, and read by the rest of the system.
import { LIMITS, MOBILE_BREAKPOINT, VENUE } from './config.js';

export const QUALITY = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' });

export class PerformanceManager {
  constructor({ onQualityChange, onMotionPreferenceChange } = {}) {
    this.onQualityChange = onQualityChange || (() => {});
    this.onMotionPreferenceChange = onMotionPreferenceChange || (() => {});
    this.listeners = { visibility: new Set(), resize: new Set() };

    this.motionQuery = window.matchMedia(VENUE.reducedMotionQuery);
    this.reducedMotion = this.motionQuery.matches;
    this.mobileQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    this.isMobile = this.mobileQuery.matches;
    this.visible = !document.hidden;
    this.dpr = 1;
    this.quality = QUALITY.HIGH;
    this.frameSamples = [];
    this.frameCount = 0;
    this.lastSampleAt = 0;
    this.degraded = false;

    this.handleMotion = (event) => {
      this.reducedMotion = event.matches;
      this.onMotionPreferenceChange(this.reducedMotion);
    };
    this.handleMobile = () => {
      this.isMobile = this.mobileQuery.matches;
    };
    this.handleVisibility = () => {
      this.visible = !document.hidden;
      for (const fn of this.listeners.visibility) fn(this.visible);
    };

    this.motionQuery.addEventListener('change', this.handleMotion);
    this.mobileQuery.addEventListener('change', this.handleMobile);
    document.addEventListener('visibilitychange', this.handleVisibility);

    this.dpr = this.targetPixelRatio();
    this.quality = this.detectInitialQuality();
  }

  /** True only when motion is both allowed and the tab is visible. */
  get animates() {
    return !this.reducedMotion;
  }

  targetPixelRatio() {
    const cap = this.isMobile ? LIMITS.mobileDprMax : LIMITS.dprMax;
    return Math.min(window.devicePixelRatio || 1, cap);
  }

  detectInitialQuality() {
    if (this.reducedMotion) return QUALITY.LOW;
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4;
    if (this.isMobile && (cores <= 4 || memory <= 2)) return QUALITY.LOW;
    if (this.isMobile) return QUALITY.MEDIUM;
    if (cores <= 4 || memory <= 2) return QUALITY.MEDIUM;
    return QUALITY.HIGH;
  }

  /** Feeds frame deltas; downgrades once if sustained frame rate is poor. */
  sample(delta, now) {
    if (this.degraded || this.reducedMotion) return;
    this.frameCount += 1;
    this.frameSamples.push(delta);
    if (this.frameSamples.length < LIMITS.downgradeWindow) return;
    const avg = this.frameSamples.reduce((sum, d) => sum + d, 0) / this.frameSamples.length;
    const fps = avg > 0 ? 1 / avg : 60;
    this.frameSamples.length = 0;
    this.lastSampleAt = now;
    if (fps < LIMITS.minFpsForDowngrade) {
      this.degraded = true;
      this.setQuality(this.quality === QUALITY.HIGH ? QUALITY.MEDIUM : QUALITY.LOW);
    }
  }

  setQuality(quality) {
    if (quality === this.quality) return;
    this.quality = quality;
    this.dpr = quality === QUALITY.LOW ? Math.min(this.targetPixelRatio(), 1.25) : this.targetPixelRatio();
    this.onQualityChange(quality);
  }

  onVisibility(fn) {
    this.listeners.visibility.add(fn);
    return () => this.listeners.visibility.delete(fn);
  }

  dispose() {
    this.motionQuery.removeEventListener('change', this.handleMotion);
    this.mobileQuery.removeEventListener('change', this.handleMobile);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.listeners.visibility.clear();
    this.listeners.resize.clear();
  }
}
