// Entry point for the venue 3D layer.
// Defines the custom element, finds the single canvas, then lazy-boots.
import { registerVenueCanvas } from '../venue-canvas.js';
import { bootstrapVenue } from './bootstrap.js';

registerVenueCanvas();

const boot = () => {
  const host = document.querySelector('sw-venue-canvas');
  const canvas = host?.canvas || document.getElementById('sw-venue-canvas');
  if (!canvas) return;
  bootstrapVenue({ canvas, host }).catch((error) => {
    console.warn('[Starwood venue] 3D unavailable, using 2D fallback:', error);
    document.documentElement.classList.add('no-3d');
  });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
