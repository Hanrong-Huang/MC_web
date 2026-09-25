// The capture orb as a small 3D model, shared by the held item (Renderer) and
// the thrown orb / capture / release effects (EntityManager): an amethyst base,
// a dark metal band with a glowing button, and a hinged glass dome built from
// layered shells (a glossy outer skin, a tinted back-face inner skin for glass
// thickness and an additive fresnel rim), plus a fixed specular glint.

import * as THREE from 'three';

/** Signature glow per capturable mob: filled-orb button, inner light, beams. */
export const ORB_GLOW: Record<string, number> = {
  zombie: 0x8fdc76, skeleton: 0xe8e4ff, creeper: 0x9ae884, spider: 0xff6a50,
  phantom: 0xa6f28e, cinderling: 0xffa050, ashstalker: 0xff8a3a, emberghast: 0xff7a30,
};
/** Idle glow of an empty orb's button. */
export const ORB_IDLE_GLOW = 0xd8c4ff;

export interface OrbRig {
  /** unrotated container; the specular glint lives here so it stays put while the ball turns */
  root: THREE.Group;
  /** everything that turns with the ball */
  spin: THREE.Group;
  /** the glass dome, hinged at the back of the band (rotation.x < 0 opens it) */
  lid: THREE.Group;
  /** the glowing button core */
  button: THREE.MeshBasicMaterial;
  /** additive halo around the button */
  halo: THREE.Sprite;
  /** light that floods the open orb (the floor disc) */
  floor: THREE.MeshBasicMaterial;
  /** captive figurine / inner light holder, standing on the band plane */
  inner: THREE.Group;
  R: number;
}

let glowTex: THREE.Texture | null = null;
let glintTex: THREE.Texture | null = null;

/** Soft round additive glow (shared by halos, beams' ends and the release flash). */
export function orbGlowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

let starTex: THREE.Texture | null = null;

/** A four-point twinkle star (capture click burst, flight trail glints). */
export function orbStarTexture(): THREE.Texture {
  if (starTex) return starTex;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 7);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 32, 32);
  x.fillStyle = 'rgba(255,255,255,0.95)';
  x.beginPath();
  // slim diamond rays along both axes
  x.moveTo(16, 0); x.lineTo(18, 14); x.lineTo(32, 16); x.lineTo(18, 18);
  x.lineTo(16, 32); x.lineTo(14, 18); x.lineTo(0, 16); x.lineTo(14, 14);
  x.closePath();
  x.fill();
  starTex = new THREE.CanvasTexture(c);
  return starTex;
}

/** A curved window-reflection streak, the glass's fixed specular glint. */
function glintTexture(): THREE.Texture {
  if (glintTex) return glintTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  x.strokeStyle = 'rgba(255,255,255,0.95)';
  x.lineCap = 'round';
  x.lineWidth = 9;
  x.beginPath();
  x.arc(44, 44, 30, Math.PI * 1.08, Math.PI * 1.42);
  x.stroke();
  x.fillStyle = 'rgba(255,255,255,0.9)';
  x.beginPath();
  x.arc(38, 8, 4, 0, Math.PI * 2);
  x.fill();
  glintTex = new THREE.CanvasTexture(c);
  return glintTex;
}

/** Additive fresnel rim: bright where the surface turns away from the eye. */
function rimMaterial(color: number, amount: number, power = 2.4): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uAmt: { value: amount }, uPow: { value: power } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uAmt; uniform float uPow;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float f = pow(1.0 - max(0.0, dot(normalize(vN), normalize(vV))), uPow);
        gl_FragColor = vec4(uColor * f * uAmt, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

/** Build the orb. `glow` tints the button + inner light (a mob's ORB_GLOW when
 *  full); `figurine` is placed inside, standing on the band plane. */
export function buildOrbRig(R: number, glow = ORB_IDLE_GLOW, figurine?: THREE.Object3D): OrbRig {
  const root = new THREE.Group();
  const spin = new THREE.Group();
  root.add(spin);
  const up = Math.PI / 2;

  // amethyst base (lower hemisphere) + its rim light
  spin.add(new THREE.Mesh(
    new THREE.SphereGeometry(R, 28, 12, 0, Math.PI * 2, up, up),
    new THREE.MeshPhongMaterial({ color: 0x8a5fd0, emissive: 0x1c0f34, specular: 0xb89cff, shininess: 60 }),
  ));
  const baseRim = new THREE.Mesh(new THREE.SphereGeometry(R * 1.004, 28, 12, 0, Math.PI * 2, up, up), rimMaterial(0xc9a4ff, 0.8));
  baseRim.renderOrder = 3;
  spin.add(baseRim);
  // floor disc capping the base: dark inside the closed orb, flooded with
  // light while the dome is open
  const floorMat = new THREE.MeshBasicMaterial({ color: 0x2a1c44 });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(R * 0.97, 28), floorMat);
  floor.rotation.x = -up;
  floor.position.y = 0.002 * R;
  spin.add(floor);

  // metal band around the equator, a touch proud of the shell
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 1.035, R * 1.035, R * 0.2, 36, 1, true),
    new THREE.MeshPhongMaterial({ color: 0x2c2240, specular: 0x9a88c0, shininess: 90, side: THREE.DoubleSide }),
  );
  spin.add(band);
  // button: dark bezel, unlit glowing core, additive halo
  const bezel = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.3, R * 0.3, R * 0.14, 22),
    new THREE.MeshPhongMaterial({ color: 0x160e22, specular: 0x6a5a88, shininess: 80 }),
  );
  bezel.rotation.x = up;
  bezel.position.z = R * 0.99;
  spin.add(bezel);
  const button = new THREE.MeshBasicMaterial({ color: glow });
  const core = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.18, R * 0.18, R * 0.16, 18), button);
  core.rotation.x = up;
  core.position.z = R * 1.03;
  spin.add(core);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: orbGlowTexture(), color: glow, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0.6,
  }));
  halo.scale.setScalar(R * 1.1);
  halo.position.z = R * 1.14;
  spin.add(halo);

  // captive / inner light, standing on the band plane under the dome
  const inner = new THREE.Group();
  spin.add(inner);
  if (figurine) inner.add(figurine);

  // glass dome, hinged at the back of the band
  const lid = new THREE.Group();
  lid.position.z = -R;
  spin.add(lid);
  const dome = new THREE.Group();
  dome.position.z = R;
  lid.add(dome);
  const topHalf = (r: number): THREE.SphereGeometry => new THREE.SphereGeometry(r, 28, 12, 0, Math.PI * 2, 0, up);
  // inner skin, back faces only: the far wall of the glass, tinted, so the
  // dome reads as thick glass rather than a bubble
  const innerSkin = new THREE.Mesh(topHalf(R * 0.93), new THREE.MeshPhongMaterial({
    color: 0x9c80e0, emissive: 0x241640, specular: 0xffffff, shininess: 40,
    transparent: true, opacity: figurine ? 0.18 : 0.34, depthWrite: false, side: THREE.BackSide,
  }));
  innerSkin.renderOrder = 1;
  dome.add(innerSkin);
  // outer skin: very clear, very glossy (the light's hot spot sits on it)
  const outer = new THREE.Mesh(topHalf(R), new THREE.MeshPhongMaterial({
    color: 0xe6dcff, emissive: 0x1a1030, specular: 0xffffff, shininess: 180,
    transparent: true, opacity: 0.22, depthWrite: false,
  }));
  outer.renderOrder = 2;
  dome.add(outer);
  const domeRim = new THREE.Mesh(topHalf(R * 1.006), rimMaterial(0xe8dcff, 1.1, 2.0));
  domeRim.renderOrder = 3;
  dome.add(domeRim);
  // a thin lip where the dome meets the band
  const lip = new THREE.Mesh(
    new THREE.TorusGeometry(R * 1.0, R * 0.045, 6, 36),
    new THREE.MeshPhongMaterial({ color: 0x4a3a66, specular: 0xcfc0ff, shininess: 100 }),
  );
  lip.rotation.x = up;
  lip.position.y = R * 0.1;
  dome.add(lip);

  // the fixed glint: a window reflection on the upper-left of the glass
  const glint = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glintTexture(), transparent: true, depthWrite: false, opacity: 0.7,
  }));
  glint.scale.setScalar(R * 0.62);
  glint.position.set(-R * 0.42, R * 0.6, R * 0.8);
  glint.renderOrder = 4;
  root.add(glint);
  root.userData.glint = glint;

  return { root, spin, lid, button, halo, floor: floorMat, inner, R };
}

/** Swing the dome open: 0 = shut, 1 = fully open (~110 degrees). */
export function setOrbOpen(rig: OrbRig, a: number): void {
  rig.lid.rotation.x = -Math.max(0, Math.min(1, a)) * 1.9;
  // the fixed glint belongs to the closed glass
  const glint = rig.root.userData.glint as THREE.Sprite | undefined;
  if (glint) glint.visible = a < 0.15;
}

/** Scale a mob mesh to stand inside an orb of radius R (facing out the front). */
export function fitFigurine(mesh: THREE.Object3D, R: number): THREE.Group {
  const holder = new THREE.Group();
  holder.add(mesh);
  mesh.rotation.y = Math.PI; // mob models face -z; the orb's front is +z
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const s = Math.min((R * 0.9) / Math.max(1e-3, size.y), (R * 1.35) / Math.max(1e-3, size.x, size.z));
  holder.scale.setScalar(s);
  // stand it on the floor, centred
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  mesh.position.set(-cx, -box.min.y + 0.01, -cz);
  return holder;
}

/** Free the orb's geometries + materials (shared textures stay cached). */
export function disposeOrb(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    // sprites share one static quad geometry: never dispose that
    if (m.geometry && !(o as THREE.Sprite).isSprite) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
  });
}
