// Maps DOM scroll to venue chapter progress.
// Dependency-free: rAF-throttled scroll + ResizeObserver, no ScrollTrigger
// requirement, so it also works inside Wix custom-element containers.
import { CHAPTERS } from './config.js';
import { clamp } from './utils/animation.js';

export class ScrollController {
  constructor({ onProgress, onChapter, reducedMotion = false } = {}) {
    this.onProgress = onProgress || (() => {});
    this.onChapter = onChapter || (() => {});
    this.reducedMotion = reducedMotion;
    this.sections = [];
    this.metrics = [];
    this.progress = 0;
    this.chapterIndex = 0;
    this.raf = 0;
    this.enabled = false;

    this.handleScroll = this.handleScroll.bind(this);
  }

  init() {
    this.sections = CHAPTERS.map((chapter) => document.getElementById(chapter.id)).filter(Boolean);
    this.measure();
    window.addEventListener('scroll', this.handleScroll, { passive: true });
    window.addEventListener('resize', this.handleScroll, { passive: true });
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => this.measure());
      this.resizeObserver.observe(document.body);
    }
    this.enabled = true;
    this.handleScroll();
    return this;
  }

  measure() {
    const scrollY = window.scrollY;
    this.metrics = this.sections.map((section) => {
      const rect = section.getBoundingClientRect();
      return { top: rect.top + scrollY, height: rect.height };
    });
  }

  handleScroll() {
    if (!this.enabled || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.compute();
    });
  }

  compute() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    this.progress = max > 0 ? clamp(window.scrollY / max) : 0;
    this.onProgress(this.progress);

    const center = window.scrollY + window.innerHeight * 0.5;
    let index = 0;
    for (let i = 0; i < this.metrics.length; i += 1) {
      const { top, height } = this.metrics[i];
      if (center >= top && center < top + height) {
        index = i;
        break;
      }
      if (center >= top + height) index = Math.min(i + 1, this.metrics.length - 1);
    }

    if (index !== this.chapterIndex) {
      this.chapterIndex = index;
      this.onChapter(index, CHAPTERS[index]?.id ?? 'entrance');
    }
  }

  dispose() {
    this.enabled = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    window.removeEventListener('scroll', this.handleScroll);
    window.removeEventListener('resize', this.handleScroll);
    this.resizeObserver?.disconnect();
    this.sections.length = 0;
    this.metrics.length = 0;
  }
}
