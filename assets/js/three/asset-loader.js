// Centralized asset loader. All textures/GLTFs flow through one cache so
// nothing is fetched twice and every GPU resource has a single dispose path.
export class AssetLoader {
  constructor(THREE, { onProgress } = {}) {
    this.THREE = THREE;
    this.textures = new Map();
    this.models = new Map();
    this.pending = new Map();
    this.onProgress = onProgress || (() => {});
    this.loader = new THREE.TextureLoader();
  }

  loadTexture(key, url, options = {}) {
    if (this.textures.has(key)) return Promise.resolve(this.textures.get(key));
    if (this.pending.has(key)) return this.pending.get(key);

    const promise = new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (texture) => {
          texture.colorSpace = this.THREE.SRGBColorSpace;
          if (options.anisotropy) texture.anisotropy = options.anisotropy;
          this.textures.set(key, texture);
          this.pending.delete(key);
          this.emit();
          resolve(texture);
        },
        undefined,
        () => {
          this.pending.delete(key);
          reject(new Error(`AssetLoader: failed to load texture "${key}" from ${url}`));
        }
      );
    });

    this.pending.set(key, promise);
    return promise;
  }

  getTexture(key) {
    return this.textures.get(key) || null;
  }

  emit() {
    this.onProgress({
      textures: this.textures.size,
      models: this.models.size,
      pending: this.pending.size
    });
  }

  dispose() {
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.pending.clear();
    this.models.clear();
  }
}
