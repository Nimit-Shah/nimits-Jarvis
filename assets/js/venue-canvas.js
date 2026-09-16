// <sw-venue-canvas> — the single WebGL host.
// Works as a Wix Studio / Velo custom element: one instance per page, creates
// one canvas, and reuses the SceneManager singleton if one already exists.
import { VENUE } from './three/config.js';
import { getSceneManager } from './three/scene-manager.js';

const TEMPLATE = `
  <style>
    :host {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      background: transparent;
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
      opacity: 0;
      transition: opacity 900ms ease;
    }
    :host([data-ready="true"]) canvas { opacity: 1; }
    @media (prefers-reduced-motion: reduce) {
      canvas { transition: none; }
    }
  </style>
  <canvas id="${VENUE.canvasId}" aria-hidden="true" role="presentation"></canvas>
`;

export class VenueCanvas extends HTMLElement {
  connectedCallback() {
    if (this.dataset.mounted === 'true') return;
    this.dataset.mounted = 'true';

    const root = this.attachShadow ? this.attachShadow({ mode: 'open' }) : this;
    if (!this.shadowRoot) {
      // No shadow DOM (Wix-embedded context): render inline instead.
      root.innerHTML = `<canvas id="${VENUE.canvasId}" aria-hidden="true" role="presentation"></canvas>`;
    } else {
      root.innerHTML = TEMPLATE;
    }

    this.canvas = root.getElementById
      ? root.getElementById(VENUE.canvasId)
      : root.querySelector(`#${VENUE.canvasId}`);

    this.setAttribute('aria-hidden', 'true');
    this.dispatchEvent(new CustomEvent('sw-venue-ready', { bubbles: true }));
  }

  disconnectedCallback() {
    this.dataset.mounted = 'false';
    const sceneManager = getSceneManager();
    if (sceneManager) sceneManager.dispose();
  }
}

export const registerVenueCanvas = () => {
  if (!customElements.get('sw-venue-canvas')) {
    customElements.define('sw-venue-canvas', VenueCanvas);
  }
};
