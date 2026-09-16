// Luxury Wedding Stage Scene — Starwood Events.
// Elegant wedding reception at night: champagne/ivory/burgundy palette,
// polished reflective floor, floral arches, hanging fairy pendants, and atmospheric embers.
import { COLORS } from '../config.js';
import { pulse } from '../utils/animation.js';

export const weddingStageScene = {
  name: 'wedding-stage',

  build({ THREE, materials, quality }) {
    const group = new THREE.Group();
    group.name = 'wedding-stage';
    const disposables = [];

    const track = (geometry) => {
      disposables.push(geometry);
      return geometry;
    };

    // --- 1. Polished Luxury Floor -------------------------------------------
    // Satin noir polished floor that catches specular highlights from stage & fairy lights.
    const floorGeo = track(new THREE.PlaneGeometry(100, 100, 2, 2));
    const floor = new THREE.Mesh(floorGeo, materials.polishedFloorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    group.add(floor);

    // Subtle aisle runner: deep burgundy velvet with champagne brass borders
    const runnerGeo = track(new THREE.PlaneGeometry(3.6, 28));
    const runner = new THREE.Mesh(runnerGeo, materials.burgundyFabricMat);
    runner.rotation.x = -Math.PI / 2;
    runner.position.set(0, 0.005, 7.5);
    group.add(runner);

    const borderGeo = track(new THREE.PlaneGeometry(0.08, 28));
    const leftBorder = new THREE.Mesh(borderGeo, materials.brassMat);
    const rightBorder = new THREE.Mesh(borderGeo, materials.brassMat);
    leftBorder.rotation.x = -Math.PI / 2;
    rightBorder.rotation.x = -Math.PI / 2;
    leftBorder.position.set(-1.8, 0.008, 7.5);
    rightBorder.position.set(1.8, 0.008, 7.5);
    group.add(leftBorder, rightBorder);

    // --- 2. Elegant Multi-tier Stage ---------------------------------------
    // Base plinth in ivory marble, upper deck in dark timber with brass edge inlay
    const basePlinthGeo = track(new THREE.BoxGeometry(8.4, 0.22, 4.8));
    const basePlinth = new THREE.Mesh(basePlinthGeo, materials.stageMarbleMat);
    basePlinth.position.set(0, 0.11, -0.4);
    group.add(basePlinth);

    const upperDeckGeo = track(new THREE.BoxGeometry(7.6, 0.22, 4.0));
    const upperDeck = new THREE.Mesh(upperDeckGeo, materials.woodMat);
    upperDeck.position.set(0, 0.33, -0.4);
    group.add(upperDeck);

    // Brass edge trims for luxury detail
    const brassTrimGeo = track(new THREE.BoxGeometry(7.64, 0.03, 4.04));
    const brassTrim = new THREE.Mesh(brassTrimGeo, materials.brassMat);
    brassTrim.position.set(0, 0.44, -0.4);
    group.add(brassTrim);

    // Front stage steps (wide ceremonial entrance onto deck)
    const step1Geo = track(new THREE.BoxGeometry(4.6, 0.11, 0.55));
    const step1 = new THREE.Mesh(step1Geo, materials.stageMarbleMat);
    step1.position.set(0, 0.055, 1.85);
    group.add(step1);

    const step2Geo = track(new THREE.BoxGeometry(4.0, 0.11, 0.55));
    const step2 = new THREE.Mesh(step2Geo, materials.stageMarbleMat);
    step2.position.set(0, 0.165, 1.45);
    group.add(step2);

    // --- 3. Stately Mandap Architecture -------------------------------------
    // Fluted architectural pillars framing the focal sanctuary
    const pillarGeo = track(new THREE.CylinderGeometry(0.12, 0.15, 3.8, 16));
    const pillarPedestalGeo = track(new THREE.BoxGeometry(0.55, 0.4, 0.55));

    const pillarPositions = [
      [-2.8, -1.8],
      [2.8, -1.8],
      [-2.8, 0.8],
      [2.8, 0.8]
    ];

    pillarPositions.forEach(([x, z]) => {
      const pedestal = new THREE.Mesh(pillarPedestalGeo, materials.stageMarbleMat);
      pedestal.position.set(x, 0.55, z);
      const pillar = new THREE.Mesh(pillarGeo, materials.plasterMat);
      pillar.position.set(x, 2.45, z);
      const cap = new THREE.Mesh(pillarPedestalGeo, materials.brassMat);
      cap.position.set(x, 4.38, z);
      cap.scale.set(0.75, 0.3, 0.75);
      group.add(pedestal, pillar, cap);
    });

    // Arch beams and concentric brass rings
    const beamGeo = track(new THREE.BoxGeometry(6.2, 0.18, 0.32));
    const frontBeam = new THREE.Mesh(beamGeo, materials.brassMat);
    frontBeam.position.set(0, 4.4, 0.8);
    const backBeam = new THREE.Mesh(beamGeo, materials.brassMat);
    backBeam.position.set(0, 4.4, -1.8);
    group.add(frontBeam, backBeam);

    const archGeo = track(new THREE.TorusGeometry(2.8, 0.055, 12, 48, Math.PI));
    const arch = new THREE.Mesh(archGeo, materials.brassMat);
    arch.position.set(0, 4.35, -1.75);
    group.add(arch);

    const innerArchGeo = track(new THREE.TorusGeometry(2.4, 0.035, 10, 40, Math.PI));
    const innerArch = new THREE.Mesh(innerArchGeo, materials.brassMat);
    innerArch.position.set(0, 4.35, -1.72);
    group.add(innerArch);

    // --- 4. Layered Drapes & Backdrop ---------------------------------------
    const backdropGeo = track(new THREE.PlaneGeometry(8.2, 4.2));
    const backdrop = new THREE.Mesh(backdropGeo, materials.backdropMat);
    backdrop.position.set(0, 2.4, -2.4);
    group.add(backdrop);

    // Side drapery cascades: alternating charcoal and deep burgundy velvet
    const drapeGeo = track(new THREE.PlaneGeometry(1.2, 4.2, 1, 8));
    const drapes = [];
    const drapeConfigs = [
      { x: -3.8, z: -2.0, rotY: 0.22, mat: materials.fabricMat },
      { x: -3.1, z: -1.8, rotY: 0.12, mat: materials.burgundyFabricMat },
      { x: -2.3, z: -2.1, rotY: 0.05, mat: materials.fabricMat },
      { x: 2.3, z: -2.1, rotY: -0.05, mat: materials.fabricMat },
      { x: 3.1, z: -1.8, rotY: -0.12, mat: materials.burgundyFabricMat },
      { x: 3.8, z: -2.0, rotY: -0.22, mat: materials.fabricMat }
    ];

    drapeConfigs.forEach(({ x, z, rotY, mat }) => {
      const drape = new THREE.Mesh(drapeGeo, mat);
      drape.position.set(x, 2.35, z);
      drape.rotation.y = rotY;
      group.add(drape);
      drapes.push(drape);
    });

    // --- 5. Floral Arrangements (Champagne, Ivory, Burgundy) ----------------
    // Shared flower sphere geometry scaled to represent lush hydrangea/rose bunches
    const flowerGeo = track(new THREE.SphereGeometry(0.14, 7, 6));
    const floralGroup = new THREE.Group();

    // Cascading floral clusters along the arch crown
    const archFloralCount = quality === 'low' ? 18 : 36;
    for (let i = 0; i <= archFloralCount; i += 1) {
      const theta = (i / archFloralCount) * Math.PI;
      const r = 2.8;
      const x = -r * Math.cos(theta);
      const y = 4.35 + r * Math.sin(theta);
      const isChampagne = i % 2 === 0;
      const flower = new THREE.Mesh(
        flowerGeo,
        isChampagne ? materials.champagneFloralMat : materials.burgundyFloralMat
      );
      flower.position.set(
        x + (Math.random() - 0.5) * 0.22,
        y + (Math.random() - 0.5) * 0.2,
        -1.72 + (Math.random() - 0.5) * 0.18
      );
      const scale = 0.9 + Math.random() * 0.5;
      flower.scale.set(scale, scale * 0.85, scale);
      floralGroup.add(flower);
    }

    // Floral runner cascades around front pillar bases
    const pillarFloralPositions = [-2.8, 2.8];
    pillarFloralPositions.forEach((px) => {
      const clusterCount = quality === 'low' ? 8 : 16;
      for (let i = 0; i < clusterCount; i += 1) {
        const ang = Math.random() * Math.PI * 2;
        const rad = 0.25 + Math.random() * 0.45;
        const fx = px + Math.cos(ang) * rad;
        const fz = 0.8 + Math.sin(ang) * rad;
        const fy = 0.45 + Math.random() * 0.55;
        const isBurgundy = Math.random() > 0.45;
        const flower = new THREE.Mesh(
          flowerGeo,
          isBurgundy ? materials.burgundyFloralMat : materials.champagneFloralMat
        );
        flower.position.set(fx, fy, fz);
        const s = 0.85 + Math.random() * 0.4;
        flower.scale.set(s, s * 0.9, s);
        floralGroup.add(flower);
      }
    });

    // Front stage deck edge floral runner
    const deckFloralCount = quality === 'low' ? 10 : 22;
    for (let i = 0; i < deckFloralCount; i += 1) {
      const fx = -3.4 + (i / (deckFloralCount - 1)) * 6.8;
      const flower = new THREE.Mesh(
        flowerGeo,
        i % 3 === 0 ? materials.burgundyFloralMat : materials.champagneFloralMat
      );
      flower.position.set(fx, 0.45, 1.55 + (Math.random() - 0.5) * 0.12);
      flower.scale.set(0.9, 0.75, 0.9);
      floralGroup.add(flower);
    }
    group.add(floralGroup);

    // --- 6. Subtle Overhead Hanging Lights & Pendants -----------------------
    // Delicate vertical fairy light strings suspended over the aisle & stage wings
    const hangingLightGeo = track(new THREE.SphereGeometry(0.042, 6, 6));
    const hangingLights = [];
    const strandCount = quality === 'low' ? 12 : 28;

    for (let s = 0; s < strandCount; s += 1) {
      const strandX = (Math.random() - 0.5) * 8.4;
      const strandZ = 1.0 + Math.random() * 8.0;
      const baseY = 3.6 + Math.random() * 1.8;
      const drops = 2 + Math.floor(Math.random() * 3);

      for (let d = 0; d < drops; d += 1) {
        const lightMesh = new THREE.Mesh(hangingLightGeo, materials.hangingLightMat);
        const y = baseY - d * 0.48;
        lightMesh.position.set(strandX, y, strandZ);
        group.add(lightMesh);
        hangingLights.push({
          mesh: lightMesh,
          initialY: y,
          phase: Math.random() * Math.PI * 2,
          speed: 0.8 + Math.random() * 0.6
        });
      }
    }

    // --- 7. Diyas & Candle Embers -------------------------------------------
    const diyaGeo = track(new THREE.SphereGeometry(0.065, 8, 8));
    const diyas = [];
    for (let i = 0; i < 9; i += 1) {
      const diya = new THREE.Mesh(diyaGeo, materials.emberMat);
      diya.position.set(-3.2 + i * 0.8, 0.52, 1.62);
      group.add(diya);
      diyas.push(diya);
    }

    // Aisle lanterns flanking the carpet
    const lanternCount = 6;
    for (let i = 0; i < lanternCount; i += 1) {
      const lz = 3.2 + i * 2.1;
      [-2.1, 2.1].forEach((lx) => {
        const lanternBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.24, 0.44, 0.24)), materials.brassMat);
        lanternBase.position.set(lx, 0.22, lz);
        const candle = new THREE.Mesh(diyaGeo, materials.emberMat);
        candle.position.set(lx, 0.35, lz);
        group.add(lanternBase, candle);
        diyas.push(candle);
      });
    }

    // --- 8. Floating Atmospheric Particles & Gold Dust ---------------------
    let dust = null;
    if (quality !== 'low') {
      const particleCount = quality === 'medium' ? 180 : 340;
      const dustPositions = new Float32Array(particleCount * 3);
      for (let i = 0; i < particleCount; i += 1) {
        dustPositions[i * 3] = (Math.random() - 0.5) * 16;
        dustPositions[i * 3 + 1] = 0.2 + Math.random() * 6.5;
        dustPositions[i * 3 + 2] = -2.5 + Math.random() * 15;
      }
      const dustGeo = track(new THREE.BufferGeometry());
      dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
      const dustMat = new THREE.PointsMaterial({
        color: COLORS.warmGlow,
        size: 0.035,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      dust = new THREE.Points(dustGeo, dustMat);
      group.add(dust);
    }

    // Cloned emissive materials to allow pulsing without global mutation
    const emberMaterial = materials.emberMat.clone();
    disposables.push(emberMaterial);
    for (const diya of diyas) diya.material = emberMaterial;

    const hangingMaterial = materials.hangingLightMat.clone();
    disposables.push(hangingMaterial);
    for (const hl of hangingLights) hl.mesh.material = hangingMaterial;

    return {
      group,
      /** @param {number} dt @param {number} elapsed */
      update(dt, elapsed) {
        // Organic diya flame breathing
        emberMaterial.emissiveIntensity = pulse(elapsed, 1.8, 1.0, 1.6);
        // Soft twinkle on overhead fairy lights
        hangingMaterial.emissiveIntensity = pulse(elapsed, 2.4, 1.8, 2.8);

        // Gentle floating drift on drapes
        for (let i = 0; i < drapes.length; i += 1) {
          drapes[i].rotation.z = Math.sin(elapsed * 0.4 + i * 1.1) * 0.012;
        }

        // Hanging pendants micro-sway
        for (let i = 0; i < hangingLights.length; i += 1) {
          const item = hangingLights[i];
          item.mesh.position.y = item.initialY + Math.sin(elapsed * item.speed + item.phase) * 0.025;
        }

        // Atmospheric dust rotation and slow vertical drift
        if (dust) {
          dust.rotation.y += dt * 0.014;
        }
      },
      dispose() {
        for (const geometry of disposables) geometry.dispose();
        if (dust) dust.material.dispose();
        group.clear();
      }
    };
  }
};
