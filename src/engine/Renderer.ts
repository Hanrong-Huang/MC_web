// Rendering: chunk meshes, sky/fog/day-night, square sun & moon, flat drifting
// clouds, stars, block outline + crack overlay, and the first-person held item.

import * as THREE from 'three';
import { Atlas, extrudeSpriteGeometry } from './Textures';
import { ChunkGeometry } from './Mesher';
import { def, hasDef } from './Blocks';

const DAY_SKY = new THREE.Color(0x82b8ff);
const NIGHT_SKY = new THREE.Color(0x0a0c1c);
const DAWN_TINT = new THREE.Color(0xd99c66);
const THUNDER_SKY = new THREE.Color(0x4a4f5a);
const FLASH_WHITE = new THREE.Color(0xf4f4ff);

// Chunk shader: vertex 'alight' = (sky-lit, torch-lit). Sky scales with the
// day/night uniform; torch light is constant and slightly warm, so torch-lit
// areas stay bright at night.
const CHUNK_VERT = /* glsl */ `
attribute vec2 alight;
attribute vec3 atint;
varying vec2 vLight;
varying vec3 vTint;
varying vec2 vUv2;
#ifdef WATER_WAVE
uniform float uTime;
#endif
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv2 = uv;
  vLight = alight;
  vTint = atint;
  vec3 transformed = position;
#ifdef WATER_WAVE
  vec4 wp = modelMatrix * vec4(position, 1.0);
  transformed.y += sin(uTime * 1.7 + wp.x * 0.9 + wp.z * 0.7) * 0.035 - 0.035;
#endif
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const CHUNK_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uDay;
uniform float uOpacity;
uniform float uAlphaTest;
varying vec2 vLight;
varying vec3 vTint;
varying vec2 vUv2;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 tex = texture2D(map, vUv2);
  if (tex.a < uAlphaTest) discard;
  vec3 sky = vec3(vLight.x * uDay);
  vec3 torch = vLight.y * vec3(1.0, 0.91, 0.74);
  // moonlight floor so sheltered night faces never go fully black
  vec3 light = max(max(sky, torch), vec3(0.06, 0.06, 0.08));
  gl_FragColor = vec4(tex.rgb * vTint * light, tex.a * uOpacity);
  #include <fog_fragment>
  #include <colorspace_fragment>
}
`;

function makeChunkMaterial(atlas: Atlas, opts: { alphaTest: number; opacity: number; transparent: boolean; wave?: boolean }): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      map: { value: atlas.texture },
      uDay: { value: 1 },
      uTime: { value: 0 },
      uOpacity: { value: opts.opacity },
      uAlphaTest: { value: opts.alphaTest },
    },
    defines: opts.wave ? { WATER_WAVE: '' } : {},
    vertexShader: CHUNK_VERT,
    fragmentShader: CHUNK_FRAG,
    fog: true,
    transparent: opts.transparent,
    side: opts.transparent ? THREE.DoubleSide : THREE.FrontSide,
  });
  return mat;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private overlayScene = new THREE.Scene();
  private overlayCamera: THREE.PerspectiveCamera;

  solidMat: THREE.ShaderMaterial;
  waterMat: THREE.ShaderMaterial;

  private chunkMeshes = new Map<string, { solid?: THREE.Mesh; water?: THREE.Mesh }>();
  // newly-streamed chunks fade in (opacity 0->1) so terrain eases into view at
  // the fog edge instead of popping. Re-meshes of already-visible chunks (block
  // edits) skip the fade. Each fading mesh gets a temporary material clone that
  // is swapped back to the shared material once the fade completes.
  private fading: { mesh: THREE.Mesh; clone: THREE.ShaderMaterial; base: THREE.ShaderMaterial; baseOpacity: number; t: number }[] = [];
  private static readonly FADE_TIME = 1.0;
  private outline: THREE.LineSegments;
  private crackMesh: THREE.Mesh;
  private crackMat: THREE.MeshBasicMaterial;

  private sun: THREE.Mesh;
  private moon: THREE.Mesh;
  private stars: THREE.Points;
  private starsMat: THREE.PointsMaterial;
  private clouds: THREE.Mesh;
  private cloudTex: THREE.CanvasTexture;
  private fog: THREE.Fog;

  private hemi: THREE.HemisphereLight;
  private dir: THREE.DirectionalLight;

  // held item
  private heldGroup = new THREE.Group();
  private heldMesh: THREE.Object3D | null = null;
  private bowArrow: THREE.Object3D | null = null;
  /** resting rotation for the current held sprite (tools differ from the bow) */
  private heldIdleRot = new THREE.Euler(0.18, -0.35, -0.62);
  private heldId = -1;
  private swingT = 1; // 0..1, 1 = idle
  private raiseT = 1; // 0..1, drives the raise-up when the held item changes
  private bowCharge = 0;
  private bobT = 0;
  private atlas: Atlas;
  private heldLight: THREE.HemisphereLight;

  daylight = 1;

  constructor(parent: HTMLElement, atlas: Atlas) {
    this.atlas = atlas;
    this.three = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.three.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.three.setSize(window.innerWidth, window.innerHeight);
    this.three.autoClear = false;
    this.canvas = this.three.domElement;
    this.canvas.id = 'game-canvas';
    parent.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 1000);
    this.camera.rotation.order = 'YXZ';
    this.overlayCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 10);

    this.fog = new THREE.Fog(DAY_SKY.clone(), 90, 124);
    this.scene.fog = this.fog;
    this.scene.background = DAY_SKY.clone();

    this.solidMat = makeChunkMaterial(atlas, { alphaTest: 0.35, opacity: 1, transparent: false });
    this.waterMat = makeChunkMaterial(atlas, { alphaTest: 0, opacity: 0.8, transparent: true, wave: true });

    // entity lights (chunk lighting is baked; these affect Lambert mob materials)
    this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b5a45, 0.95);
    this.dir = new THREE.DirectionalLight(0xffffff, 0.55);
    this.dir.position.set(0.4, 1, 0.6);
    this.scene.add(this.hemi, this.dir);

    // block outline
    const og = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    this.outline = new THREE.LineSegments(
      og, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.85 }),
    );
    this.outline.visible = false;
    this.scene.add(this.outline);

    // crack overlay
    this.crackMat = new THREE.MeshBasicMaterial({
      map: atlas.crackTextures[0], transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.crackMesh = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), this.crackMat);
    this.crackMesh.visible = false;
    this.scene.add(this.crackMesh);

    // sun + moon (square, fog-immune, occluded by terrain)
    this.sun = this.makeSkyQuad('#fdffb0', '#fff6e0', 56);
    this.moon = this.makeSkyQuad('#e8ecf4', '#c8ccd8', 40);
    this.scene.add(this.sun, this.moon);

    // stars
    const starGeo = new THREE.BufferGeometry();
    const starPos: number[] = [];
    const rng = (() => { let s = 12345; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    for (let i = 0; i < 600; i++) {
      const t = rng() * Math.PI * 2, p = Math.acos(rng() * 2 - 1);
      const r = 450;
      starPos.push(r * Math.sin(p) * Math.cos(t), r * Math.cos(p), r * Math.sin(p) * Math.sin(t));
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.starsMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false,
    });
    this.stars = new THREE.Points(starGeo, this.starsMat);
    this.stars.renderOrder = -3;
    this.scene.add(this.stars);

    // clouds: flat plane high above, blocky texture, drifting
    this.cloudTex = this.makeCloudTexture();
    const cloudMat = new THREE.MeshBasicMaterial({
      map: this.cloudTex, transparent: true, opacity: 0.85, fog: false,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(1536, 1536), cloudMat);
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = 130;
    this.clouds.renderOrder = 2;
    this.scene.add(this.clouds);

    // held-item overlay
    this.heldLight = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
    this.overlayScene.add(this.heldLight);
    this.overlayScene.add(this.heldGroup);
    this.setHeldItem(0);

    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.overlayCamera.aspect = this.camera.aspect;
    this.overlayCamera.updateProjectionMatrix();
    this.three.setSize(window.innerWidth, window.innerHeight);
  };

  private makeSkyQuad(inner: string, outer: string, size: number): THREE.Mesh {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = outer; ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = inner; ctx.fillRect(2, 2, 12, 12);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: tex, fog: false, depthWrite: false, transparent: true }),
    );
    m.renderOrder = -2;
    return m;
  }

  private makeCloudTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, 128, 128);
    let s = 777;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    // blobby rectangular clouds
    for (let i = 0; i < 26; i++) {
      const x = (rng() * 128) | 0, y = (rng() * 128) | 0;
      const w = 4 + ((rng() * 12) | 0), h = 3 + ((rng() * 7) | 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, w, h);
      ctx.fillRect((x + 2) % 128, (y + h - 1) % 128, Math.max(2, w - 4), 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }

  setViewDistance(chunks: number): void {
    const d = chunks * 16;
    // a wider near..far band gives a gentler distance gradient so terrain
    // dissolves into the sky rather than ending at a hard wall.
    this.fog.near = Math.max(24, d - 62);
    this.fog.far = Math.max(44, d - 8);
  }

  // --- chunk meshes ---------------------------------------------------------

  setChunkGeometry(key: string, cx: number, cz: number, geo: ChunkGeometry): void {
    // a fresh load (no existing mesh) fades in; a re-mesh after a block edit
    // already has a mesh and should swap in instantly to avoid flicker.
    const isNew = !this.chunkMeshes.has(key);
    this.removeChunk(key);
    const entry: { solid?: THREE.Mesh; water?: THREE.Mesh } = {};
    if (geo.solid) {
      const m = new THREE.Mesh(geo.solid, this.solidMat);
      m.position.set(cx * 16, 0, cz * 16);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.scene.add(m);
      entry.solid = m;
      if (isNew) this.beginFade(m, this.solidMat, 1);
    }
    if (geo.water) {
      const m = new THREE.Mesh(geo.water, this.waterMat);
      m.position.set(cx * 16, 0, cz * 16);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.renderOrder = 1;
      this.scene.add(m);
      entry.water = m;
      if (isNew) this.beginFade(m, this.waterMat, 0.8);
    }
    this.chunkMeshes.set(key, entry);
  }

  /** Give a freshly-loaded chunk mesh a temporary transparent material clone
   *  that ramps opacity 0 -> baseOpacity, then restores the shared material. */
  private beginFade(mesh: THREE.Mesh, base: THREE.ShaderMaterial, baseOpacity: number): void {
    const clone = base.clone();
    clone.transparent = true;
    clone.depthWrite = true; // still occlude so terrain behind doesn't bleed through
    clone.uniforms.uOpacity.value = 0;
    mesh.material = clone;
    this.fading.push({ mesh, clone, base, baseOpacity, t: 0 });
  }

  /** Advance per-chunk fade-ins; called once per frame. */
  updateChunkFades(dt: number): void {
    if (this.fading.length === 0) return;
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      f.t += dt / Renderer.FADE_TIME;
      const k = Math.min(1, f.t);
      const eased = k * k * (3 - 2 * k); // smoothstep
      f.clone.uniforms.uOpacity.value = f.baseOpacity * eased;
      // keep day/night + water-wave time in sync with the shared material
      f.clone.uniforms.uDay.value = f.base.uniforms.uDay.value;
      f.clone.uniforms.uTime.value = f.base.uniforms.uTime.value;
      if (k >= 1) {
        f.mesh.material = f.base;
        f.clone.dispose();
        this.fading.splice(i, 1);
      }
    }
  }

  removeChunk(key: string): void {
    const e = this.chunkMeshes.get(key);
    if (!e) return;
    if (e.solid) { this.endFade(e.solid); this.scene.remove(e.solid); e.solid.geometry.dispose(); }
    if (e.water) { this.endFade(e.water); this.scene.remove(e.water); e.water.geometry.dispose(); }
    this.chunkMeshes.delete(key);
  }

  /** Drop any in-flight fade for a mesh that is being removed. */
  private endFade(mesh: THREE.Mesh): void {
    for (let i = this.fading.length - 1; i >= 0; i--) {
      if (this.fading[i].mesh === mesh) {
        this.fading[i].clone.dispose();
        this.fading.splice(i, 1);
      }
    }
  }

  // --- highlight / cracks ---------------------------------------------------

  setOutline(pos: { x: number; y: number; z: number } | null): void {
    if (!pos) { this.outline.visible = false; return; }
    this.outline.visible = true;
    this.outline.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
  }

  setCrack(pos: { x: number; y: number; z: number } | null, stage: number): void {
    if (!pos || stage < 0) { this.crackMesh.visible = false; return; }
    this.crackMesh.visible = true;
    this.crackMesh.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
    this.crackMat.map = this.atlas.crackTextures[Math.min(9, stage)];
    this.crackMat.needsUpdate = true;
  }

  // --- environment ----------------------------------------------------------

  /**
   * t in [0,1): 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight.
   * Returns the current light level in [0.16, 1].
   * `weatherDark` (0..1) dims the sky for rain/thunder; `flash` (0..1) whites
   * it out briefly on a lightning strike.
   */
  updateEnvironment(t: number, camX: number, camZ: number, elapsed: number,
    weatherDark = 0, flash = 0): number {
    const ang = t * Math.PI * 2;
    const sunY = Math.sin(ang);
    const sunX = Math.cos(ang);
    let light = Math.max(0.16, Math.min(1, sunY * 2.4 + 0.42));
    // precipitation dims the world
    light = Math.max(0.1, light * (1 - weatherDark * 0.6));
    this.daylight = light;

    // sky + fog color, with a dawn/dusk tint
    const sky = NIGHT_SKY.clone().lerp(DAY_SKY, Math.max(0, Math.min(1, (light - 0.16) / 0.84)));
    const duskAmount = Math.max(0, 1 - Math.abs(sunY) * 5) * 0.45;
    sky.lerp(DAWN_TINT, duskAmount);
    // weather grey-wash + lightning flash
    if (weatherDark > 0) sky.lerp(THUNDER_SKY, weatherDark * 0.8);
    if (flash > 0) sky.lerp(FLASH_WHITE, flash);
    (this.scene.background as THREE.Color).copy(sky);
    this.fog.color.copy(sky);

    this.solidMat.uniforms.uDay.value = light;
    this.waterMat.uniforms.uDay.value = light;
    this.waterMat.uniforms.uTime.value = elapsed;
    this.hemi.intensity = 0.25 + light * 0.75;
    this.dir.intensity = 0.1 + light * 0.5;
    this.heldLight.intensity = 0.35 + light * 0.75;

    // sun and moon ride a great circle around the camera
    const R = 420;
    this.sun.position.set(camX + sunX * R, sunY * R, camZ);
    this.sun.lookAt(this.camera.position);
    this.moon.position.set(camX - sunX * R, -sunY * R, camZ);
    this.moon.lookAt(this.camera.position);
    this.sun.visible = sunY > -0.18 && weatherDark < 0.6;
    this.moon.visible = sunY < 0.18 && weatherDark < 0.6;

    this.starsMat.opacity = Math.max(0, Math.min(1, (0.45 - light) * 3));
    this.stars.position.set(camX, 0, camZ);

    // clouds stay centered on the camera; uv offset keeps them world-anchored + wind
    this.clouds.position.x = camX;
    this.clouds.position.z = camZ;
    const worldPerTile = 768; // 128px * 6 blocks/px
    this.cloudTex.repeat.set(1536 / worldPerTile, 1536 / worldPerTile);
    this.cloudTex.offset.set(
      ((camX + elapsed * 1.4) % worldPerTile) / worldPerTile,
      (-camZ % worldPerTile) / worldPerTile,
    );
    // clouds thicken + darken with weather
    (this.clouds.material as THREE.MeshBasicMaterial).opacity = 0.6 + weatherDark * 0.35;
    return light;
  }

  // --- held item / arm ------------------------------------------------------

  setHeldItem(id: number): void {
    if (id === this.heldId) return;
    this.heldId = id;
    this.raiseT = 0; // animate the new item up into view
    if (this.heldMesh) {
      this.heldGroup.remove(this.heldMesh);
      this.heldMesh.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      this.heldMesh = null;
    }
    if (this.bowArrow) {
      this.heldGroup.remove(this.bowArrow);
      this.overlayScene.remove(this.bowArrow);
      this.bowArrow.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      this.bowArrow = null;
    }
    if (id !== 0 && hasDef(id) && def(id).block && !def(id).opaque && !def(id).solid) {
      // cutout decorations (torch): hold the flat tile, not a black cube
      const d = def(id);
      const tile = this.atlas.tileCanvas(d.faces!.sides);
      const tex = new THREE.CanvasTexture(tile);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 0.5),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide }),
      );
      mesh.rotation.y = Math.PI * 0.12;
      this.heldMesh = mesh;
    } else if (id !== 0 && hasDef(id) && def(id).block) {
      const d = def(id);
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      // BoxGeometry face order: +x,-x,+y,-y,+z,-z; 4 uvs per face
      const faceNames = [
        d.faces!.sides, d.faces!.sides, d.faces!.top,
        d.faces!.bottom, d.faces!.front ?? d.faces!.sides, d.faces!.sides,
      ];
      for (let f = 0; f < 6; f++) {
        const r = this.atlas.rect(faceNames[f]);
        const us = [r.u0, r.u1, r.u0, r.u1];
        const vs = [r.v0, r.v0, r.v1, r.v1];
        for (let v = 0; v < 4; v++) uv.setXY(f * 4 + v, us[v], vs[v]);
      }
      uv.needsUpdate = true;
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: this.atlas.texture, alphaTest: 0.35 }));
      mesh.scale.setScalar(0.34);
      // a slight 3/4 tilt so the top + two side faces all catch the light
      mesh.rotation.set(-0.16, 0.5, 0);
      this.heldMesh = mesh;
    } else if (id !== 0 && hasDef(id) && def(id).sprite) {
      // pixel sprite extruded into a real 3D voxel model (Minecraft-style),
      // so tools/items in hand read with depth instead of as a flat card.
      const sprite = this.atlas.sprite(def(id).sprite!);
      const mesh = sprite ? this.buildExtrudedItem(sprite) : new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 0.5),
        new THREE.MeshBasicMaterial({ color: 0xff00ff }),
      );
      // grip angle: tools/items sit diagonally in the fist, head up + away.
      // the bow is held upright (limbs vertical, string toward the player) so it
      // reads as a bow rather than a stick lying across the hand.
      this.heldIdleRot.set(0.18, -0.35, -0.62);
      if (def(id).bow) this.heldIdleRot.set(0.05, 0.45, 0.12);
      mesh.rotation.copy(this.heldIdleRot);
      this.heldMesh = mesh;
      if (def(id).bow) {
        this.bowArrow = this.buildHeldArrow();
        this.bowArrow.visible = false;
        this.overlayScene.add(this.bowArrow);
      }
    } else {
      // bare arm
      const armMat = new THREE.MeshLambertMaterial({ color: 0xd8a988 });
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.7), armMat);
      arm.position.set(0.16, -0.22, 0.1); // anchored into the corner
      arm.rotation.set(0.7, -0.55, 0.25);
      this.heldMesh = arm;
    }
    this.heldGroup.add(this.heldMesh);
  }

  triggerSwing(): void {
    this.swingT = 0;
  }

  setBowCharge(charge: number): void {
    this.bowCharge = Math.max(0, Math.min(1, charge));
  }

  /** Update held-item animation; `moving` drives view bob. */
  updateHeld(dt: number, moving: boolean): void {
    if (this.swingT < 1) this.swingT = Math.min(1, this.swingT + dt / 0.28);
    if (this.raiseT < 1) this.raiseT = Math.min(1, this.raiseT + dt / 0.16);
    this.bobT += dt * (moving ? 7 : 2);
    const s = this.swingT;
    const swingAngle = Math.sin(Math.min(1, s) * Math.PI) * 1.1;
    const bob = moving ? Math.sin(this.bobT) * 0.012 : Math.sin(this.bobT) * 0.004;
    // new item raises into view on a hotbar switch (smoothstep ease)
    const rk = this.raiseT;
    const lower = (1 - rk * rk * (3 - 2 * rk)) * 0.42;
    const drawingBow = this.bowCharge > 0.01 && this.heldId !== 0 && hasDef(this.heldId) && !!def(this.heldId).bow;

    if (drawingBow) {
      const pull = this.bowCharge;
      this.heldGroup.position.set(0.30 - pull * 0.02, -0.30 + bob * 0.14 - lower, -0.74 - pull * 0.03);
      this.heldGroup.rotation.set(-0.06 - pull * 0.05, 0.05, -0.04);
      if (this.heldMesh) {
        // keep the bow upright (matching the idle pose) while the string draws back
        this.heldMesh.scale.setScalar(1.0 + pull * 0.06);
        this.heldMesh.rotation.set(0.05, 0.62, 0.10);
      }
      if (this.bowArrow) {
        // arrow nocked across the bow, pointing forward at the crosshair; it
        // slides back toward the player as the draw deepens
        this.bowArrow.visible = true;
        this.bowArrow.position.set(0.0, -0.02, -0.74 + pull * 0.14);
        this.bowArrow.rotation.set(0, Math.PI * 0.5, 0);
        this.bowArrow.scale.set(0.85, 0.85, 1.0);
      }
      return;
    }

    if (this.bowArrow && this.heldMesh) {
      this.heldMesh.scale.setScalar(1);
      this.heldMesh.rotation.copy(this.heldIdleRot);
    }
    if (this.bowArrow) this.bowArrow.visible = false;

    this.heldGroup.position.set(
      0.42 - swingAngle * 0.18,
      -0.36 + bob - swingAngle * 0.10 - lower,
      -0.62 + swingAngle * 0.08,
    );
    this.heldGroup.rotation.set(
      -swingAngle * 0.9 + bob * 2,
      0.25 + swingAngle * 0.5,
      swingAngle * 0.25,
    );
  }

  private buildExtrudedItem(sprite: HTMLCanvasElement): THREE.Mesh {
    return new THREE.Mesh(
      extrudeSpriteGeometry(sprite, 0.56),
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
  }

  private buildHeldArrow(): THREE.Group {
    const g = new THREE.Group();
    const shaftMat = new THREE.MeshBasicMaterial({ color: 0x8a6232 });
    const tipMat = new THREE.MeshBasicMaterial({ color: 0xd0d0d8 });
    const featherMat = new THREE.MeshBasicMaterial({ color: 0xf6f6f6 });
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.020, 0.40), shaftMat);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.038, 0.07), tipMat);
    tip.position.z = -0.24;
    const featherA = new THREE.Mesh(new THREE.BoxGeometry(0.074, 0.016, 0.10), featherMat);
    featherA.position.z = 0.23;
    featherA.position.y = 0.040;
    const featherB = featherA.clone();
    featherB.position.y = -0.040;
    g.add(shaft, tip, featherA, featherB);
    return g;
  }

  // --- frame ----------------------------------------------------------------

  render(underwater: boolean): void {
    if (underwater) {
      this.fog.color.setRGB(0.1 * this.daylight, 0.2 * this.daylight, 0.45 * this.daylight);
      (this.scene.background as THREE.Color).copy(this.fog.color);
      const oldNear = this.fog.near, oldFar = this.fog.far;
      this.fog.near = 2; this.fog.far = 24;
      this.three.clear();
      this.three.render(this.scene, this.camera);
      this.fog.near = oldNear; this.fog.far = oldFar;
    } else {
      this.three.clear();
      this.three.render(this.scene, this.camera);
    }
    this.three.clearDepth();
    this.three.render(this.overlayScene, this.overlayCamera);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    for (const key of [...this.chunkMeshes.keys()]) this.removeChunk(key);
    this.three.dispose();
    this.canvas.remove();
  }
}
