// Rendering: chunk meshes (custom 2-channel light shader), a gradient sky dome
// with sunrise/sunset glow, sun/moon with phases, twinkling stars, Minecraft-
// style blocky clouds, distance fog that dissolves terrain into the exact sky
// color behind it, block outline + crack overlay, and the first-person held item.

import * as THREE from 'three';
import { Atlas, extrudeSpriteGeometry, shapedItemGeometry, hasShapedItemModel, BLOCK_SPRITE_ICONS } from './Textures';
import type { ChunkMeshData, GeoArrays } from './Mesher';
import { B, def, hasDef, spriteNameFor, I, CROSS_BLOCKS } from './Blocks';
import { buildOrbRig, disposeOrb, fitFigurine, ORB_GLOW, ORB_IDLE_GLOW, OrbRig } from './CatcherOrb';
import { MobModels } from './MobModels';
import type { MobKind } from './EntityManager';

/** Held-orb throw timeline (fractions of ORB_THROW_TIME): the wind-up ends and
 *  the orb leaves the hand at ORB_RELEASE (EntityManager.CATCHER_WINDUP s). */
const ORB_THROW_TIME = 0.55;
const ORB_WIND = 0.2;
const ORB_RELEASE = 0.22;

export interface ChunkGeometry {
  solid: THREE.BufferGeometry | null;
  water: THREE.BufferGeometry | null;
}

/** Build a THREE.BufferGeometry from raw mesher arrays (main thread only). */
export function geometryFromArrays(a: GeoArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
  g.setAttribute('alight', new THREE.BufferAttribute(a.lights, 2));
  g.setAttribute('atint', new THREE.BufferAttribute(a.tints, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(a.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(a.indices, 1));
  // the mesher reports the vertical extent, so the culling volume is tight
  // without a per-vertex computeBoundingSphere pass on the main thread
  const y0 = a.minY ?? -1, y1 = a.maxY ?? 161;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.5, y0 - 0.5, -0.5), new THREE.Vector3(16.5, y1 + 0.5, 16.5));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}

export function chunkGeometryFromArrays(d: ChunkMeshData): ChunkGeometry {
  return {
    solid: d.solid ? geometryFromArrays(d.solid) : null,
    water: d.water ? geometryFromArrays(d.water) : null,
  };
}

// --- palette (sRGB hex; THREE.Color converts to the linear working space) ----
const DAY_ZENITH = new THREE.Color(0x5f97ec);
const DAY_HORIZON = new THREE.Color(0xb4d2f6);
const NIGHT_ZENITH = new THREE.Color(0x020309);
const NIGHT_HORIZON = new THREE.Color(0x0b1024);
const DUSK_HAZE = new THREE.Color(0xe4a878);
const SUNSET_GLOW = new THREE.Color(0xff7a38);
const RAIN_ZENITH = new THREE.Color(0x626a78);
const RAIN_HORIZON = new THREE.Color(0x868d98);
const FLASH_WHITE = new THREE.Color(0xf4f4ff);
const NETHER_FOG = new THREE.Color(0x3a0f0b);
const WATER_FOG = new THREE.Color(0x1d4a8c);
const LAVA_FOG = new THREE.Color(0xd2410a);

const SKY_DAY_LIGHT = new THREE.Color(1, 0.98, 0.95);
const SKY_DUSK_LIGHT = new THREE.Color(1.0, 0.72, 0.52);
const SKY_NIGHT_LIGHT = new THREE.Color(0.05, 0.06, 0.1);
const TORCH_LIGHT = new THREE.Color(1.0, 0.78, 0.5);
const CLOUD_DAY = new THREE.Color(1, 1, 1);
const CLOUD_DUSK = new THREE.Color(1.0, 0.66, 0.52);
const CLOUD_NIGHT = new THREE.Color(0.055, 0.06, 0.09);
const CLOUD_RAIN = new THREE.Color(0.36, 0.38, 0.42);

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Shared sky-color function: the dome, the terrain/water/cloud fog and the
// water reflections all call it, so fully-fogged terrain is *exactly* the sky
// behind it (no ghost silhouettes at any time of day). Uniforms are shared
// objects, set once per frame in updateEnvironment.
const SKY_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uGlow;
uniform float uGlowAmt;
uniform vec3 uFlatCol;
uniform float uFlat;
vec3 skyColor(vec3 d) {
  float up = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(uHorizon, uZenith, 1.0 - pow(1.0 - up, 3.0));
  float s = max(dot(d, uSunDir), 0.0);
  // sunrise / sunset: a warm glow fanning out from the sun along the horizon
  float low = 1.0 - smoothstep(-0.1, 0.42, d.y);
  float glow = uGlowAmt * (pow(s, 6.0) * 0.85 + s * s * 0.16) * low;
  c = mix(c, uGlow, clamp(glow, 0.0, 0.92));
  return mix(c, uFlatCol, uFlat);
}
`;

// Cheap animated caustic web (iterated domain warp), roughly 0..1 with thin
// bright filaments. Used for the underwater light on terrain and the light
// dancing on shallow water.
const CAUSTIC_GLSL = /* glsl */ `
float caustic(vec2 uv, float t) {
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
  }
  c = 1.17 - pow(c * 0.25, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.5);
}
`;

// Screen-space sway applied to clip positions while the eye is under water.
const WOBBLE_GLSL = /* glsl */ `
vec2 underwaterWobble(vec4 clip, float t) {
  vec2 s = clip.xy / max(clip.w, 0.001);
  return vec2(sin(t * 1.7 + s.y * 5.0), cos(t * 1.3 + s.x * 4.0)) * 0.006 * clip.w;
}
`;

// Water: its own shader so the fluid can be rich without taxing terrain.
// The mesher packs per-vertex water data (see Mesher's WATER VERTEX note):
//   atint = (flow x, flow z | fall speed, face kind 0 top / 1 side / 2 under)
//   uv    = (water depth below the surface, shoreline 0..1)
// The fragment picks the still or flowing tile straight from the atlas with
// world-space, flow-scrolled coordinates (textureGrad keeps the per-tile mips
// seam-free), colours by depth (turquoise shallows -> deep blue), and adds
// ripple normals, Fresnel sky + cloud reflection, sun/moon glints, shoreline
// and waterfall foam, and caustic sparkle in the shallows.
const WATER_VERT = /* glsl */ `
attribute vec2 alight;
attribute vec3 atint;
uniform float uTime;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogVert;
uniform float uUnder;
varying vec2 vLight;
varying vec3 vFlow;
varying vec2 vDS;
varying vec3 vWorld;
varying vec4 vFog;
${WOBBLE_GLSL}
${SKY_GLSL}
void main() {
  vLight = alight;
  vFlow = atint;
  vDS = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  // long crossing swells (a function of world position, so shared corners stay
  // welded); the whole sheet sits a touch low so waves never poke through
  float sw = sin(uTime * 1.25 + wp.x * 0.55 + wp.z * 0.23) * 0.5
    + sin(uTime * 1.65 - wp.x * 0.31 + wp.z * 0.64) * 0.33
    + sin(uTime * 2.7 + wp.x * 1.13 + wp.z * 0.87) * 0.17;
  wp.y += sw * 0.04 - 0.045;
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.xy += underwaterWobble(gl_Position, uTime) * uUnder;
  vec3 toV = wp.xyz - cameraPosition;
  float dist = max(length(toV.xz), abs(toV.y) * uFogVert);
  vFog = vec4(0.0, 0.0, 0.0, smoothstep(uFogNear, uFogFar, dist));
  if (vFog.a > 0.0) vFog.rgb = skyColor(normalize(toV));
}
`;

const WATER_FRAG = /* glsl */ `
uniform sampler2D map;
uniform sampler2D uCloudMap;
uniform vec4 uStillRect;
uniform vec4 uFlowRect;
uniform float uWaterLum;
uniform float uFade;
uniform float uTime;
uniform float uGlint;
uniform float uUnder;
uniform vec3 uSkyLight;
uniform vec3 uTorchCol;
uniform vec3 uAmbient;
uniform vec3 uTintMul;
uniform vec3 uCloudCol;
uniform vec3 uCloudInfo; // layer origin x, z, visibility
varying vec2 vLight;
varying vec3 vFlow;
varying vec2 vDS;
varying vec3 vWorld;
varying vec4 vFog;
${SKY_GLSL}
${CAUSTIC_GLSL}
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
// one tile of the atlas, wrapped in world space with explicit gradients so
// the fract() wrap doesn't drop to the smallest mip along tile seams
float tileLum(vec4 r, vec2 p) {
  vec2 sz = r.zw - r.xy;
  vec3 c = textureGrad(map, r.xy + fract(p) * sz, dFdx(p) * sz, dFdy(p) * sz).rgb;
  return dot(c, vec3(0.2126, 0.7152, 0.0722)) / uWaterLum;
}
const vec3 SHALLOW = vec3(0.045, 0.36, 0.50);
const vec3 DEEP = vec3(0.007, 0.036, 0.19);
const vec3 FOAM = vec3(0.86, 0.93, 0.97);
void main() {
  if (uFade < 0.999 && bayer4(gl_FragCoord.xy) >= uFade) discard;
  float t = uTime;
  float kind = vFlow.z;
  vec2 p = vWorld.xz;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 v = toCam / dist;
  vec3 light = max(max(vLight.x * uSkyLight, vLight.y * uTorchCol), uAmbient);
  float skyVis = smoothstep(0.15, 0.75, vLight.x);

  // --- texture: still shimmer / flowing streaks / falling sheets -------------
  float detail;
  float foam = 0.0;
  vec2 ripple = vec2(0.0);
  float fade = 1.0 / (1.0 + dist * 0.045); // ripple detail eases off with distance
  if (kind < 0.5) {
    float spd = length(vFlow.xy);
    // still: two layers drifting against each other
    float still = 0.5 * (tileLum(uStillRect, p + vec2(t * 0.045, t * 0.02))
      + tileLum(uStillRect, p * 0.5 + vec2(0.37 - t * 0.03, 0.61 + t * 0.041)));
    // flowing: the streak tile rotated onto the flow and scrolled downstream
    vec2 fd = spd > 0.001 ? vFlow.xy / spd : vec2(0.0, 1.0);
    vec2 q = vec2(dot(p, vec2(fd.y, -fd.x)), dot(p, fd) - t * (0.9 + spd * 0.7));
    float flowing = tileLum(uFlowRect, q);
    float fk = smoothstep(0.02, 0.35, spd);
    detail = mix(still, flowing, fk);
    // ripple normals: crossing wavelets, advected downstream on moving water
    vec2 pa = p - fd * t * spd * 1.4;
    ripple += vec2(0.8, 0.6) * cos(dot(pa, vec2(0.8, 0.6)) * 3.3 + t * 2.1);
    ripple += vec2(-0.5, 0.87) * cos(dot(pa, vec2(-0.5, 0.87)) * 4.7 - t * 2.6) * 0.7;
    ripple += vec2(0.28, -0.96) * cos(dot(pa, vec2(0.28, -0.96)) * 7.3 + t * 3.4) * 0.45;
    ripple += vec2(-0.93, -0.36) * cos(dot(pa, vec2(-0.93, -0.36)) * 11.0 - t * 4.1) * 0.3;
    ripple *= (0.05 + fk * 0.05) * fade;
    // lapping shoreline foam: a wobbly band hugging solid edges, plus a
    // little white water on fast flows
    // (vDS.y is 1 at corners touching a shore or a plunging waterfall); the
    // texture's lighter crests break the band into lapping patches
    float lap = 0.5 + 0.5 * sin(t * 1.6 + p.x * 1.3 - p.y * 0.9);
    foam = smoothstep(0.35, 0.95, vDS.y) * smoothstep(0.85, 1.3, still + lap * 0.35) * 0.8;
    foam += fk * smoothstep(1.25, 1.6, flowing) * 0.2;
  } else if (kind < 1.5) {
    // side faces: sheets sliding down (fast on waterfalls, lazy on lake edges)
    float spd = vFlow.y;
    vec2 q = vec2(vWorld.x + vWorld.z, vWorld.y + t * (0.35 + spd * 1.6));
    detail = tileLum(uFlowRect, q);
    foam = spd * smoothstep(1.08, 1.4, detail) * 0.7;
  } else {
    detail = tileLum(uStillRect, p + vec2(t * 0.03, 0.0));
  }

  // --- body colour: depth-graded, lit, caustic sparkle in the shallows ------
  float depth = vDS.x;
  float dk = 1.0 - exp(-depth * 0.42);
  vec3 body = mix(SHALLOW, DEEP, dk) * light * mix(0.8, 1.25, clamp(detail - 0.3, 0.0, 1.0));
  if (kind < 0.5) body += SHALLOW * light * caustic(p * 0.22, t * 0.5) * (1.0 - dk) * 0.9 * skyVis;
  else if (kind < 1.5) body = mix(body, SHALLOW * light * 1.7, 0.4 * vFlow.y); // aerated falls
  float alpha = kind < 0.5 ? mix(0.42, 0.9, dk) : kind < 1.5 ? 0.78 : 0.7;

  // --- surface normal -------------------------------------------------------
  vec3 gn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  bool below = false;
  if (dot(gn, v) < 0.0) gn = -gn;
  if (kind < 0.5 && gn.y < 0.0) below = true; // looking up at the surface
  vec3 n = normalize(gn + vec3(-ripple.x, 0.0, -ripple.y) * (below ? -1.0 : 1.0));
  float cv = clamp(dot(n, v), 0.0, 1.0);

  vec3 col;
  if (below) {
    // from under water: a bright Snell's window straight up, total internal
    // reflection (dark water) toward the edges
    float win = smoothstep(0.55, 0.8, cv);
    vec3 up = mix(uHorizon, uZenith, 0.45) * (0.35 + 0.65 * skyVis) + SHALLOW * light * 0.5;
    col = mix(body * 0.7, up * 1.1 + body * 0.3, win);
    alpha = mix(0.92, 0.55, win);
  } else {
    // Fresnel: glassy looking down, a mirror of sky and clouds at grazing angles
    float F = 0.02 + 0.98 * pow(1.0 - cv, 5.0);
    if (kind > 0.5) F *= 0.35;
    vec3 r = reflect(-v, n);
    r.y = abs(r.y);
    vec3 refl = skyColor(r);
    if (r.y > 0.015 && uCloudInfo.z > 0.0) {
      // the real cloud layer, intersected along the reflected ray
      float th = (172.0 - vWorld.y) / r.y;
      vec2 hit = vWorld.xz + r.xz * th;
      float cf = 1.0 - smoothstep(136.0, 340.0, length(hit - cameraPosition.xz));
      if (cf > 0.0) {
        float cell = texture2D(uCloudMap, (hit - uCloudInfo.xy) / 768.0).r;
        refl = mix(refl, uCloudCol, cell * cf * uCloudInfo.z);
      }
    }
    // under an overhang or deep in a cave the sky isn't there to reflect
    refl = mix(body * 0.6, refl, skyVis);
    col = mix(body, refl, F);
    alpha = mix(alpha, 1.0, F);
    // sun glint (sharp sparkle + soft sheen) and a faint moon path at night
    float sunUp = smoothstep(-0.05, 0.1, uSunDir.y);
    vec3 hs = normalize(uSunDir + v);
    float ns = max(dot(n, hs), 0.0);
    // the sharp term only fires on the texture's crests, so the sun path
    // breaks into pixel glitter instead of a blown-out blob
    float glitter = smoothstep(0.95, 1.35, detail);
    float spec = (pow(ns, 700.0) * 3.5 * glitter + pow(ns, 160.0) * 0.12) * uGlint * sunUp;
    vec3 hm = normalize(-uSunDir + v);
    float moon = pow(max(dot(n, hm), 0.0), 300.0) * 1.6 * (1.0 - uGlint) * step(uSunDir.y, 0.0);
    col += (uSkyLight * spec + vec3(0.55, 0.62, 0.8) * moon) * skyVis;
    alpha = max(alpha, min(1.0, spec + moon));
  }

  // foam rides on top of everything
  col = mix(col, FOAM * light, foam);
  alpha = max(alpha, foam * 0.95);

  col *= uTintMul;
  col = mix(col, vFog.rgb, vFog.a);
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

// Chunk shader: vertex 'alight' = (sky-lit, torch-lit). Sky light is tinted
// by the time of day (warm at dusk, blue moonlight at night); torch light is a
// warm, gently flickering color. The torch channel carries flag bits (+2 sway,
// +4 lava) that the vertex shader strips.
const CHUNK_VERT = /* glsl */ `
attribute vec2 alight;
attribute vec3 atint;
uniform float uTime;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogVert;
varying vec2 vLight;
varying vec3 vTint;
varying vec2 vUv2;
varying vec3 vWorld;
varying float vLava;
varying vec4 vFog; // rgb = sky color behind this vertex, a = fog amount
uniform float uUnder;
${WOBBLE_GLSL}
${SKY_GLSL}
void main() {
  vUv2 = uv;
  vTint = atint;
  float flag = floor(alight.y * 0.5);
  vLight = vec2(alight.x, alight.y - flag * 2.0);
  vLava = step(1.5, flag);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  if (flag > 0.5 && flag < 1.5) {
    // leaves / plant tops sway in the wind (a function of world position, so
    // shared corners move together and never crack apart)
    float ph = wp.x * 0.61 + wp.z * 0.83 + wp.y * 0.29;
    float gust = 0.6 + 0.4 * sin(uTime * 0.35 + wp.x * 0.05);
    wp.x += sin(uTime * 1.7 + ph) * 0.028 * gust;
    wp.z += cos(uTime * 1.3 + ph * 1.21) * 0.022 * gust;
  }
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.xy += underwaterWobble(gl_Position, uTime) * uUnder;
  // fog evaluated per vertex (chunk faces are 1 block, so it interpolates
  // cleanly) — keeps the per-pixel cost at a texture fetch + a few MADs
  vec3 toV = wp.xyz - cameraPosition;
  // cylindrical fog (chunks stream in a horizontal circle); height only counts
  // a little in air so the ground stays visible when flying high
  float dist = max(length(toV.xz), abs(toV.y) * uFogVert);
  vec3 dir = normalize(toV);
  vFog = vec4(0.0, 0.0, 0.0, smoothstep(uFogNear, uFogFar, dist));
  if (vFog.a > 0.0) vFog.rgb = skyColor(dir); // near geometry skips the sky math
}
`;

const CHUNK_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uOpacity;
uniform float uAlphaTest;
uniform float uFade;
uniform float uTime;
uniform float uGlint;
uniform vec3 uSunDir;
uniform vec3 uSkyLight;
uniform vec3 uTorchCol;
uniform vec3 uAmbient;
uniform vec3 uTintMul;
varying vec2 vLight;
varying vec3 vTint;
varying vec2 vUv2;
varying vec3 vWorld;
varying float vLava;
varying vec4 vFog;
uniform float uUnder;
${CAUSTIC_GLSL}
// 4x4 ordered (Bayer) dither for the chunk fade-in (stays in the opaque pass)
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
void main() {
  if (uFade < 0.999 && bayer4(gl_FragCoord.xy) >= uFade) discard;
  vec4 tex = texture2D(map, vUv2);
  if (tex.a < uAlphaTest) discard;
  vec3 light = max(max(vLight.x * uSkyLight, vLight.y * uTorchCol), uAmbient);
  vec3 col = tex.rgb * vTint * light;
  if (vLava > 0.5) {
    // lava glows on its own and slowly churns
    float churn = sin(uTime * 1.3 + vWorld.x * 1.7 + vWorld.z * 1.1) * sin(uTime * 0.9 - vWorld.z * 1.9 + vWorld.x * 0.7);
    col = tex.rgb * (1.05 + 0.18 * churn);
  }
  float alpha = tex.a * uOpacity;
  if (uUnder > 0.5 && vLava < 0.5) {
    // eye under water: sunlight caustics dance over everything in view
    float c = caustic(vWorld.xz * 0.2 + vWorld.y * 0.05, uTime * 0.6);
    col += tex.rgb * vTint * uSkyLight * max(vLight.x, 0.3) * c * 2.2;
  }
  col *= uTintMul; // e.g. the blue cast when the eye is under water
  col = mix(col, vFog.rgb, vFog.a);
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vCol;
${SKY_GLSL}
void main() {
  vCol = skyColor(normalize(position));
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // pinned to the far plane
}
`;
const SKY_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  gl_FragColor = vec4(vCol, 1.0);
  #include <colorspace_fragment>
}
`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uStarAlpha;
uniform float uPixelRatio;
varying float vA;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_PointSize = aSize * uPixelRatio;
  float tw = 0.6 + 0.4 * sin(uTime * (1.1 + aPhase * 2.3) + aPhase * 37.0);
  vec3 d = normalize(wp.xyz - cameraPosition);
  vA = uStarAlpha * tw * smoothstep(-0.02, 0.22, d.y) * (0.45 + aPhase * 0.55);
}
`;
const STAR_FRAG = /* glsl */ `
varying float vA;
void main() {
  gl_FragColor = vec4(vec3(1.0, 0.97, 0.9), vA);
  #include <colorspace_fragment>
}
`;

const CLOUD_VERT = /* glsl */ `
attribute float shade;
varying float vShade;
varying vec3 vWorld;
void main() {
  vShade = shade;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const CLOUD_FRAG = /* glsl */ `
uniform vec3 uCloudCol;
uniform float uCloudAlpha;
uniform float uCloudFar;
varying float vShade;
varying vec3 vWorld;
void main() {
  // distant clouds thin out into the sky dome behind them
  vec2 d = vWorld.xz - cameraPosition.xz;
  float fade = 1.0 - smoothstep(uCloudFar * 0.4, uCloudFar, length(d));
  gl_FragColor = vec4(uCloudCol * vShade, uCloudAlpha * fade);
  #include <colorspace_fragment>
}
`;

type U<T> = { value: T };

// held-item rest pose (radians): tilt of the head away from the player, and
// the turn about the vertical that shows the item's face at an angle
const HELD_TILT = -0.18;
const HELD_TURN = 2.36;

/** Principal axis of a sprite's opaque pixels (sprite-centered, y up): the
 *  axis angle (pointing up) and the grip point at its low end. Roundish
 *  sprites (food, orbs) keep their upright orientation. */
function spriteAxis(sprite: HTMLCanvasElement): { angle: number; gx: number; gy: number; long: boolean } {
  const W = sprite.width, H = sprite.height;
  const data = sprite.getContext('2d')!.getImageData(0, 0, W, H).data;
  const px: number[] = [], py: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 40) { px.push(x + 0.5 - W / 2); py.push(H - 1 - y + 0.5 - H / 2); }
    }
  }
  const n = px.length;
  if (n < 3) return { angle: Math.PI / 4, gx: 0, gy: -H / 2, long: false };
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += px[i]; my += py[i]; }
  mx /= n; my /= n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = px[i] - mx, dy = py[i] - my;
    cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l2 = tr - l1;
  let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const long = l1 >= l2 * 1.8;
  if (!long) angle = Math.PI / 2; // not elongated: treat as upright
  let dx = Math.cos(angle), dy = Math.sin(angle);
  if (dy < -1e-6 || (Math.abs(dy) <= 1e-6 && dx < 0)) { dx = -dx; dy = -dy; }
  angle = Math.atan2(dy, dx);
  // grip: average of the pixels at the low end of the axis
  let lo = Infinity;
  for (let i = 0; i < n; i++) lo = Math.min(lo, px[i] * dx + py[i] * dy);
  let gx = 0, gy = 0, k = 0;
  for (let i = 0; i < n; i++) {
    if (px[i] * dx + py[i] * dy <= lo + 2) { gx += px[i]; gy += py[i]; k++; }
  }
  return { angle, gx: gx / k, gy: gy / k, long };
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
  // Newly-streamed chunks fade in with an ordered dither (so terrain eases into
  // view instead of popping). The fade value lives on each mesh and is pushed
  // into the shared material's uFade from onBeforeRender, so there are no
  // per-chunk material clones — cloning used to spawn a second (transparent)
  // shader program that got destroyed and recompiled on every streaming burst.
  private fading = new Set<THREE.Mesh>();
  private static readonly FADE_TIME = 0.8;
  private crackMesh: THREE.Mesh;
  private crackMat: THREE.MeshBasicMaterial;
  private outline: THREE.LineSegments;
  /** optional block lookup (wired by main) so the outline can hug partial blocks */
  blockAt: ((x: number, y: number, z: number) => number) | null = null;
  /** outline bounds [x0,y0,z0,x1,y1,z1] for shaped blocks (slabs, stairs, fences ...), else null */
  outlineShape: ((x: number, y: number, z: number) => number[] | null) | null = null;
  /** floor on the ambient light (Night Vision potion), 0 = off */
  minAmbient = 0;

  // shared environment uniforms (sky function, fog, light colors)
  private env = {
    uZenith: { value: new THREE.Color() } as U<THREE.Color>,
    uHorizon: { value: new THREE.Color() } as U<THREE.Color>,
    uSunDir: { value: new THREE.Vector3(1, 0, 0) } as U<THREE.Vector3>,
    uGlow: { value: SUNSET_GLOW.clone() } as U<THREE.Color>,
    uGlowAmt: { value: 0 } as U<number>,
    uFlatCol: { value: new THREE.Color() } as U<THREE.Color>,
    uFlat: { value: 0 } as U<number>,
    uFogNear: { value: 66 } as U<number>,
    uFogFar: { value: 120 } as U<number>,
    uSkyLight: { value: new THREE.Color(1, 1, 1) } as U<THREE.Color>,
    uTorchCol: { value: TORCH_LIGHT.clone() } as U<THREE.Color>,
    uAmbient: { value: new THREE.Color(0.026, 0.026, 0.034) } as U<THREE.Color>,
    uTime: { value: 0 } as U<number>,
    uGlint: { value: 0 } as U<number>,
    uTintMul: { value: new THREE.Color(1, 1, 1) } as U<THREE.Color>,
    uFogVert: { value: 0.4 } as U<number>,
    uUnder: { value: 0 } as U<number>, // 1 while the eye is under water

  };
  private viewNear = 66;
  private viewFar = 120;

  private skyDome: THREE.Mesh;
  private sun: THREE.Mesh;
  private sunHalo: THREE.Mesh;
  private moon: THREE.Mesh;
  private moonTex: THREE.CanvasTexture;
  private moonCanvas: HTMLCanvasElement;
  private moonPhase = -1;
  private dayCount = 0;
  private lastT = -1;
  private stars: THREE.Points;
  private starsMat: THREE.ShaderMaterial;
  private clouds: THREE.Group;
  /** cloud cell coverage (1 texel per cell, repeating), for water reflections */
  private cloudMap: THREE.DataTexture | null = null;
  private cloudTiles: { cx: number; cz: number; meshes: THREE.Mesh[] }[] = [];
  private cloudMat: THREE.ShaderMaterial;
  private static readonly CLOUD_CELL = 12;
  private static readonly CLOUD_N = 64; // cells per repeat period
  private static readonly CLOUD_Y = 172;
  private static readonly CLOUD_TILE = 16; // cells per tile side
  private static readonly CLOUD_FAR = 340;
  private fog: THREE.Fog;
  private skyObjs: THREE.Object3D[];

  private hemi: THREE.HemisphereLight;
  private dir: THREE.DirectionalLight;

  // held item
  private heldGroup = new THREE.Group();
  private heldMesh: THREE.Object3D | null = null;
  /** held bow geometries: idle + the three pulling frames, swapped by draw */
  private bowGeos: THREE.BufferGeometry[] = [];
  private bowStage = -1;
  /** resting rotation for the current held sprite (tools differ from the bow) */
  private heldIdleRot = new THREE.Euler(0, 0, 0);
  /** resting offset of the held mesh inside the hand group */
  private heldRestPos = new THREE.Vector3();
  private heldId = -1;
  /** captured-mob kind for the held item (filled catcher), drives its sprite */
  private heldMob: string | undefined = undefined;
  /** the held item is a capture orb, which gets a slow idle spin */
  private heldIsOrb = false;
  private orbSpin = 0;
  /** the held orb's parts (button glow, dome, figurine) for its idle/throw animation */
  private orbRig: OrbRig | null = null;
  /** 0..1 progress of the wind-up / throw / follow-through (1 = idle) */
  private orbThrowT = 1;
  private orbT = 0;
  /** builds the little captive figurine shown inside a held filled orb */
  private orbModels: MobModels | null = null;
  private swingT = 1; // 0..1, 1 = idle
  private raiseT = 1; // 0..1, drives the raise-up when the held item changes
  private bowCharge = 0;
  private eatAmt = 0;     // 0..1 eased eating raise
  private eatTarget = 0;  // target set each frame by setEating
  private eatPhase = 0;   // chew oscillator
  private blockAmt = 0;    // 0..1 eased shield raise (setBlocking)
  private blockTarget = 0;
  private bobT = 0;
  private atlas: Atlas;
  private heldLight: THREE.HemisphereLight;
  private heldDir: THREE.DirectionalLight;

  // scratch objects (no per-frame allocations in the render loop)
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();
  private tmpV = new THREE.Vector3();

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
    this.overlayCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 10);

    // three's own fog only affects entity materials (mobs, drops); chunks,
    // clouds and the sky use the shared sky-color fog in their shaders
    this.fog = new THREE.Fog(DAY_HORIZON.clone(), 66, 120);
    this.scene.fog = this.fog;
    this.scene.background = null;

    this.solidMat = this.makeChunkMaterial({ alphaTest: 0.35, opacity: 1, transparent: false });
    this.waterMat = this.makeWaterMaterial();

    // entity lights (chunk lighting is baked; these affect Lambert mob materials)
    this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b5a45, 0.95);
    this.dir = new THREE.DirectionalLight(0xffffff, 0.55);
    this.dir.position.set(0.4, 1, 0.6);
    this.scene.add(this.hemi, this.dir);

    // crack overlay
    this.crackMat = new THREE.MeshBasicMaterial({
      map: atlas.crackTextures[0], transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.crackMesh = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), this.crackMat);
    this.crackMesh.visible = false;
    this.scene.add(this.crackMesh);

    // block outline: thin dark wireframe hugging the targeted block's shape
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false, fog: false }),
    );
    this.outline.visible = false;
    this.outline.renderOrder = 5;
    this.scene.add(this.outline);

    // sky dome (drawn first, pinned to the far plane)
    const e = this.env;
    this.skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(10, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: {
          uZenith: e.uZenith, uHorizon: e.uHorizon, uSunDir: e.uSunDir, uGlow: e.uGlow,
          uGlowAmt: e.uGlowAmt, uFlatCol: e.uFlatCol, uFlat: e.uFlat,
        },
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
        side: THREE.BackSide, depthWrite: false, depthTest: false,
      }),
    );
    this.skyDome.renderOrder = -10;
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);

    // sun (square core + soft additive halo) and moon (pixel art with phases)
    this.sun = this.makeSkyQuad(this.makeSunTexture(), 46, THREE.AdditiveBlending);
    this.sunHalo = this.makeSkyQuad(this.makeHaloTexture(), 190, THREE.AdditiveBlending);
    this.sunHalo.renderOrder = -3;
    this.moonCanvas = document.createElement('canvas');
    this.moonCanvas.width = 16; this.moonCanvas.height = 16;
    this.moonTex = new THREE.CanvasTexture(this.moonCanvas);
    this.moonTex.magFilter = THREE.NearestFilter;
    this.moonTex.minFilter = THREE.NearestFilter;
    this.moonTex.colorSpace = THREE.SRGBColorSpace;
    this.drawMoon(0);
    this.moon = this.makeSkyQuad(this.moonTex, 34, THREE.NormalBlending);
    this.scene.add(this.sunHalo, this.sun, this.moon);

    // stars: tiny square points that twinkle and wheel with the sky
    const starGeo = new THREE.BufferGeometry();
    const starPos: number[] = [], starSize: number[] = [], starPhase: number[] = [];
    const rng = (() => { let s = 12345; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    for (let i = 0; i < 900; i++) {
      const t = rng() * Math.PI * 2, p = Math.acos(rng() * 2 - 1);
      const r = 450;
      starPos.push(r * Math.sin(p) * Math.cos(t), r * Math.cos(p), r * Math.sin(p) * Math.sin(t));
      const b = rng();
      starSize.push(b > 0.93 ? 2.6 : b > 0.6 ? 1.7 : 1.15);
      starPhase.push(rng());
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    starGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(starSize, 1));
    starGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(starPhase, 1));
    this.starsMat = new THREE.ShaderMaterial({
      uniforms: { uTime: e.uTime, uStarAlpha: { value: 0 }, uPixelRatio: { value: this.three.getPixelRatio() } },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(starGeo, this.starsMat);
    this.stars.renderOrder = -4;
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // clouds: a blocky 12x12-cell layer with shaded sides. A depth-only pass
    // first, then color with depthFunc LEQUAL, so only the nearest cloud
    // surface blends over the sky (no see-through stacking of cloud faces).
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uCloudCol: { value: new THREE.Color(1, 1, 1) }, uCloudAlpha: { value: 0.8 }, uCloudFar: { value: Renderer.CLOUD_FAR },
      },
      vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
      transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
    });
    const depthMat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERT,
      fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
      transparent: true, colorWrite: false, depthWrite: true,
    });
    // the layer is split into tiles so only those near the camera (and in
    // view) are drawn: at a grazing angle the far cloud faces stack up into a
    // lot of overdraw for fragments the distance fade makes invisible anyway
    this.clouds = new THREE.Group();
    this.clouds.matrixAutoUpdate = false;
    for (const t of this.buildCloudTiles()) {
      const dm = new THREE.Mesh(t.geo, depthMat);
      dm.renderOrder = 3;
      const cm = new THREE.Mesh(t.geo, this.cloudMat);
      cm.renderOrder = 4;
      this.clouds.add(dm, cm);
      this.cloudTiles.push({ cx: t.cx, cz: t.cz, meshes: [dm, cm] });
    }
    this.scene.add(this.clouds);
    // water reflects the same cloud layer (same map, color and drift)
    this.waterMat.uniforms.uCloudMap.value = this.cloudMap;
    this.waterMat.uniforms.uCloudCol = this.cloudMat.uniforms.uCloudCol;
    this.skyObjs = [this.clouds, this.stars, this.sun, this.sunHalo, this.moon];

    // held-item overlay: soft sky fill + a key light from the upper left so the
    // extruded pixel edges read as 3D
    this.heldLight = new THREE.HemisphereLight(0xffffff, 0x9a8f86, 1.6);
    this.heldDir = new THREE.DirectionalLight(0xffffff, 1.4);
    this.heldDir.position.set(-0.6, 1, 0.8);
    this.overlayScene.add(this.heldLight, this.heldDir);
    this.overlayScene.add(this.heldGroup);
    this.setHeldItem(0);

    // compile both chunk programs and draw them once now (during the loading
    // screen) instead of stalling a frame mid-flight the first time water
    // scrolls into view: it must be this scene (three keys programs on its
    // lights + fog), and a real draw lets the driver finish its pipeline
    // setup for the blend state too (a 0.4 s hitch under SwiftShader).
    {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-0.01, -0.01, -1, 0.01, -0.01, -1, 0, 0.01, -1], 3));
      g.setAttribute('alight', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
      g.setAttribute('atint', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
      const warm = [new THREE.Mesh(g, this.solidMat), new THREE.Mesh(g, this.waterMat)];
      for (const m of warm) m.frustumCulled = false;
      this.scene.add(...warm);
      this.three.compile(this.scene, this.camera);
      this.three.render(this.scene, this.camera);
      this.scene.remove(...warm);
      g.dispose();
    }

    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.overlayCamera.aspect = this.camera.aspect;
    this.overlayCamera.updateProjectionMatrix();
    this.three.setSize(window.innerWidth, window.innerHeight);
  };

  private makeChunkMaterial(opts: { alphaTest: number; opacity: number; transparent: boolean; wave?: boolean }): THREE.ShaderMaterial {
    const e = this.env;
    return new THREE.ShaderMaterial({
      uniforms: {
        ...e,
        map: { value: this.atlas.texture },
        uOpacity: { value: opts.opacity },
        uAlphaTest: { value: opts.alphaTest },
        uFade: { value: 1 },
      },
      defines: opts.wave ? { WATER_WAVE: '' } : {},
      vertexShader: CHUNK_VERT,
      fragmentShader: CHUNK_FRAG,
      transparent: opts.transparent,
      side: opts.transparent ? THREE.DoubleSide : THREE.FrontSide,
    });
  }

  /** The fluid material (see WATER_FRAG); cloud uniforms are wired up once
   *  the cloud layer exists. */
  private makeWaterMaterial(): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.env,
        map: { value: this.atlas.texture },
        uFade: { value: 1 },
        uStillRect: { value: new THREE.Vector4() },
        uFlowRect: { value: new THREE.Vector4() },
        uWaterLum: { value: 0.1 },
        uCloudMap: { value: null },
        uCloudCol: { value: new THREE.Color(1, 1, 1) },
        uCloudInfo: { value: new THREE.Vector3(0, 0, 0) },
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
    });
    return mat;
  }

  /** Point the water shader at the still/flow tiles and measure the still
   *  tile's mean luminance (so a resource-pack water normalises the same). */
  private waterTilesGen = -1;
  private refreshWaterTiles(): void {
    if (this.waterTilesGen === this.atlas.generation) return;
    this.waterTilesGen = this.atlas.generation;
    const u = this.waterMat.uniforms;
    const s = this.atlas.rect('water'), f = this.atlas.rect('water_flow');
    (u.uStillRect.value as THREE.Vector4).set(s.u0, s.v0, s.u1, s.v1);
    (u.uFlowRect.value as THREE.Vector4).set(f.u0, f.v0, f.u1, f.v1);
    const cv = this.atlas.canvas;
    const x0 = Math.round(s.u0 * cv.width), y0 = Math.round(s.v0 * cv.height);
    const w = Math.max(1, Math.round((s.u1 - s.u0) * cv.width)), h = Math.max(1, Math.round((s.v1 - s.v0) * cv.height));
    const d = cv.getContext('2d')!.getImageData(x0, y0, w, h).data;
    const lin = (c: number): number => Math.pow(c / 255, 2.2);
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
    u.uWaterLum.value = Math.max(0.01, sum / (w * h));
  }

  private makeSkyQuad(tex: THREE.Texture, size: number, blending: THREE.Blending): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: tex, fog: false, depthWrite: false, transparent: true, blending }),
    );
    m.renderOrder = -2;
    m.frustumCulled = false;
    return m;
  }

  /** Minecraft-style square sun: a hot white core inside a yellow rim. */
  private makeSunTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff3a0'; ctx.fillRect(1, 1, 14, 14);
    ctx.fillStyle = '#fffbd8'; ctx.fillRect(3, 3, 10, 10);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(5, 5, 6, 6);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Soft radial glow around the sun (additive). */
  private makeHaloTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,240,200,0.55)');
    g.addColorStop(0.25, 'rgba(255,220,150,0.22)');
    g.addColorStop(0.6, 'rgba(255,200,120,0.06)');
    g.addColorStop(1, 'rgba(255,190,110,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Pixel moon with craters; `phase` 0..7 (0 = full, 4 = new) shades the lit part. */
  private drawMoon(phase: number): void {
    const ctx = this.moonCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 16, 16);
    // rounded pixel disc
    const lit = '#e9edf5', rim = '#c9cfdb', crater = '#b3bac9', dark = '#2a2e3a';
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const dx = x - 7.5, dy = y - 7.5;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > 7.2) continue;
        ctx.fillStyle = r > 6.2 ? rim : lit;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.fillStyle = crater;
    for (const [x, y, w, h] of [[4, 4, 3, 2], [9, 3, 2, 2], [10, 8, 3, 3], [5, 9, 2, 2], [7, 12, 2, 1], [3, 7, 1, 1]]) {
      ctx.fillRect(x, y, w, h);
    }
    // phase: darken a sliding portion of the disc (waxing/waning terminator)
    if (phase !== 0) {
      const k = phase <= 4 ? phase / 4 : (8 - phase) / 4; // 0 full .. 1 new
      const fromLeft = phase < 4;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const dx = x - 7.5, dy = y - 7.5;
          if (dx * dx + dy * dy > 7.2 * 7.2) continue;
          const half = Math.sqrt(Math.max(0, 7.2 * 7.2 - dy * dy));
          const u = (dx + half) / (2 * half || 1); // 0..1 across this row
          const shadowed = fromLeft ? u < k : 1 - u < k;
          if (shadowed) { ctx.fillStyle = dark; ctx.fillRect(x, y, 1, 1); }
        }
      }
    }
    this.moonTex.needsUpdate = true;
  }

  /** Tileable blocky cloud map (value noise on a torus) meshed as merged runs,
   *  cut into square tiles (local coords relative to the layer origin). */
  private buildCloudTiles(): { geo: THREE.BufferGeometry; cx: number; cz: number }[] {
    const N = Renderer.CLOUD_N, S = Renderer.CLOUD_CELL, H = 4;
    let seed = 20231;
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const lattice = (f: number): Float32Array => { const a = new Float32Array(f * f); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
    const oct = [[8, 0.6], [16, 0.3], [32, 0.14]] as const;
    const lats = oct.map(([f]) => lattice(f));
    const val = (x: number, z: number): number => {
      let v = 0;
      oct.forEach(([f, amp], k) => {
        const gx = (x / N) * f, gz = (z / N) * f;
        const x0 = Math.floor(gx), z0 = Math.floor(gz);
        const tx = gx - x0, tz = gz - z0;
        const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
        const L = lats[k];
        const at = (i: number, j: number): number => L[((j % f + f) % f) * f + ((i % f + f) % f)];
        const a = at(x0, z0) + (at(x0 + 1, z0) - at(x0, z0)) * sx;
        const b = at(x0, z0 + 1) + (at(x0 + 1, z0 + 1) - at(x0, z0 + 1)) * sx;
        v += (a + (b - a) * sz) * amp;
      });
      return v;
    };
    const cell = new Uint8Array(N * N);
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) cell[z * N + x] = val(x, z) > 0.58 ? 1 : 0;
    this.cloudMap = cloudMapTexture(cell, N);
    const filled = (x: number, z: number): boolean => cell[((z % N + N) % N) * N + ((x % N + N) % N)] === 1;

    // mesh a 2x2 repeat so the layer always covers +-N/2 cells around the camera
    const M = N * 2, T = Renderer.CLOUD_TILE;
    const tiles: { geo: THREE.BufferGeometry; cx: number; cz: number }[] = [];
    for (let tz = 0; tz < M; tz += T) {
      for (let tx = 0; tx < M; tx += T) {
        const pos: number[] = [], shade: number[] = [], idx: number[] = [];
        const quad = (a: number[], b: number[], c: number[], d: number[], sh: number): void => {
          const base = pos.length / 3;
          pos.push(...a, ...b, ...c, ...d);
          shade.push(sh, sh, sh, sh);
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        const x1t = tx + T, z1t = tz + T;
        for (let z = tz; z < z1t; z++) {
          // top/bottom faces as merged runs along x
          for (let x = tx; x < x1t;) {
            if (!filled(x, z)) { x++; continue; }
            let x1 = x; while (x1 < x1t && filled(x1, z)) x1++;
            const X0 = x * S, X1 = x1 * S, Z0 = z * S, Z1 = (z + 1) * S;
            quad([X0, H, Z1], [X1, H, Z1], [X1, H, Z0], [X0, H, Z0], 1.0);      // top (+y)
            quad([X0, 0, Z0], [X1, 0, Z0], [X1, 0, Z1], [X0, 0, Z1], 0.7);      // bottom (-y)
            x = x1;
          }
          // +z / -z walls as merged runs along x
          for (const dz of [1, -1]) {
            for (let x = tx; x < x1t;) {
              if (!filled(x, z) || filled(x, z + dz)) { x++; continue; }
              let x1 = x; while (x1 < x1t && filled(x1, z) && !filled(x1, z + dz)) x1++;
              const X0 = x * S, X1 = x1 * S, Zf = (dz > 0 ? z + 1 : z) * S;
              if (dz > 0) quad([X0, 0, Zf], [X1, 0, Zf], [X1, H, Zf], [X0, H, Zf], 0.86);
              else quad([X1, 0, Zf], [X0, 0, Zf], [X0, H, Zf], [X1, H, Zf], 0.86);
              x = x1;
            }
          }
        }
        for (let x = tx; x < x1t; x++) {
          for (const dx of [1, -1]) {
            for (let z = tz; z < z1t;) {
              if (!filled(x, z) || filled(x + dx, z)) { z++; continue; }
              let z1 = z; while (z1 < z1t && filled(x, z1) && !filled(x + dx, z1)) z1++;
              const Z0 = z * S, Z1 = z1 * S, Xf = (dx > 0 ? x + 1 : x) * S;
              if (dx > 0) quad([Xf, 0, Z1], [Xf, 0, Z0], [Xf, H, Z0], [Xf, H, Z1], 0.78);
              else quad([Xf, 0, Z0], [Xf, 0, Z1], [Xf, H, Z1], [Xf, H, Z0], 0.78);
              z = z1;
            }
          }
        }
        if (!pos.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('shade', new THREE.Float32BufferAttribute(shade, 1));
        g.setIndex(idx);
        g.computeBoundingSphere();
        tiles.push({ geo: g, cx: (tx + T / 2) * S, cz: (tz + T / 2) * S });
      }
    }
    return tiles;
  }

  setViewDistance(chunks: number): void {
    const d = chunks * 16;
    // a wide near..far band so terrain dissolves into the sky gradually; far
    // stays inside the meshed radius so the frontier is always fully fogged
    this.viewNear = Math.max(20, d * 0.6);
    this.viewFar = Math.max(40, d - 14);
  }

  // --- chunk meshes ---------------------------------------------------------

  setChunkGeometry(key: string, cx: number, cz: number, geo: ChunkGeometry): void {
    // a fresh load (no existing mesh) fades in; a re-mesh after a block edit
    // already has a mesh and should swap in instantly to avoid flicker.
    const isNew = !this.chunkMeshes.has(key);
    this.removeChunk(key);
    const entry: { solid?: THREE.Mesh; water?: THREE.Mesh } = {};
    if (geo.solid) {
      const m = this.makeChunkMesh(geo.solid, this.solidMat, cx, cz, isNew);
      entry.solid = m;
    }
    if (geo.water) {
      const m = this.makeChunkMesh(geo.water, this.waterMat, cx, cz, isNew);
      m.renderOrder = 1;
      entry.water = m;
    }
    this.chunkMeshes.set(key, entry);
  }

  private makeChunkMesh(geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial, cx: number, cz: number, fade: boolean): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(cx * 16, 0, cz * 16);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.userData.fade = fade ? 0 : 1;
    m.userData.fadeStart = performance.now();
    m.onBeforeRender = chunkBeforeRender;
    this.scene.add(m);
    if (fade) this.fading.add(m);
    return m;
  }

  /** Advance per-chunk fade-ins; called once per frame. Wall-clock based, so
   *  a low frame rate (whose dt gets clamped) can't leave chunks dithered. */
  updateChunkFades(_dt: number): void {
    if (this.fading.size === 0) return;
    const now = performance.now();
    for (const m of this.fading) {
      const f = Math.min(1, (now - (m.userData.fadeStart as number)) / (Renderer.FADE_TIME * 1000));
      m.userData.fade = f;
      if (f >= 1) this.fading.delete(m);
    }
  }

  removeChunk(key: string): void {
    const e = this.chunkMeshes.get(key);
    if (!e) return;
    if (e.solid) { this.fading.delete(e.solid); this.scene.remove(e.solid); e.solid.geometry.dispose(); }
    if (e.water) { this.fading.delete(e.water); this.scene.remove(e.water); e.water.geometry.dispose(); }
    this.chunkMeshes.delete(key);
  }

  // --- highlight / cracks ---------------------------------------------------

  /** Thin dark outline around the targeted block, shaped to partial blocks. */
  setOutline(pos: { x: number; y: number; z: number } | null): void {
    if (!pos) { this.outline.visible = false; return; }
    const id = this.blockAt ? this.blockAt(pos.x, pos.y, pos.z) : B.STONE;
    let x0 = 0, y0 = 0, z0 = 0, x1 = 1, y1 = 1, z1 = 1;
    if (id === B.TORCH) { x0 = z0 = 0.35; x1 = z1 = 0.65; y1 = 0.8; }
    else if (CROSS_BLOCKS.has(id)) { x0 = z0 = 0.12; x1 = z1 = 0.88; y1 = 0.85; }
    else if (id === B.BED || id === B.BED_HEAD) y1 = 0.5625;
    else if (id === B.PRESSURE_PLATE) { x0 = z0 = 0.0625; x1 = z1 = 0.9375; y1 = 0.08; }
    else if (id === B.REDSTONE_WIRE) y1 = 0.06;
    else if (id === B.TRAPDOOR) y0 = 0.8125;
    const shaped = this.outlineShape?.(pos.x, pos.y, pos.z);
    if (shaped) [x0, y0, z0, x1, y1, z1] = shaped;
    const e = 0.003;
    this.outline.scale.set(x1 - x0 + e * 2, y1 - y0 + e * 2, z1 - z0 + e * 2);
    this.outline.position.set(pos.x + (x0 + x1) / 2, pos.y + (y0 + y1) / 2, pos.z + (z0 + z1) / 2);
    this.outline.visible = true;
  }

  setCrack(pos: { x: number; y: number; z: number } | null, stage: number): void {
    if (!pos || stage < 0) { this.crackMesh.visible = false; return; }
    this.crackMesh.visible = true;
    this.crackMesh.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
    const tex = this.atlas.crackTextures[Math.min(9, stage)];
    if (this.crackMat.map !== tex) {
      this.crackMat.map = tex;
      this.crackMat.needsUpdate = true;
    }
  }

  // --- environment ----------------------------------------------------------

  /**
   * t in [0,1): 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight.
   * Returns the current light level in [0.16, 1].
   * `weatherDark` (0..1) dims the sky for rain/thunder; `flash` (0..1) whites
   * it out briefly on a lightning strike.
   */
  updateEnvironment(t: number, camX: number, camZ: number, elapsed: number,
    weatherDark = 0, flash = 0, isNether = false): number {
    const e = this.env;
    this.refreshWaterTiles();
    const ang = t * Math.PI * 2;
    const sunY = Math.sin(ang);
    const sunX = Math.cos(ang);
    let light = Math.max(0.16, Math.min(1, sunY * 2.4 + 0.42));
    // precipitation dims the world
    light = Math.max(0.1, light * (1 - weatherDark * 0.6));
    this.daylight = light;
    e.uTime.value = elapsed;
    this.skyDome.position.copy(this.camera.position);

    // moon phase advances once per in-game day
    if (this.lastT >= 0 && t < this.lastT - 0.5) this.dayCount++;
    this.lastT = t;
    const phase = this.dayCount % 8;
    if (phase !== this.moonPhase) { this.moonPhase = phase; this.drawMoon(phase); }

    // torch light: warm with a subtle flicker
    const flick = 0.96 + 0.025 * Math.sin(elapsed * 9.3) + 0.015 * Math.sin(elapsed * 23.1 + 1.3);
    e.uTorchCol.value.copy(TORCH_LIGHT).multiplyScalar(flick);

    if (isNether) {
      e.uFlat.value = 1;
      e.uFlatCol.value.copy(NETHER_FOG);
      e.uZenith.value.copy(NETHER_FOG);
      e.uHorizon.value.copy(NETHER_FOG);
      e.uGlowAmt.value = 0;
      e.uGlint.value = 0;
      this.viewNearOverride = 14; this.viewFarOverride = 80;
      e.uSkyLight.value.setRGB(0.2, 0.2, 0.2);
      e.uAmbient.value.setRGB(0.1, 0.065, 0.05);
      this.fog.color.copy(NETHER_FOG);
      this.hemi.intensity = 0.45;
      this.dir.intensity = 0.15;
      this.setHeldLightLevel(0.55);

      this.sun.visible = false;
      this.sunHalo.visible = false;
      this.moon.visible = false;
      this.stars.visible = false;
      this.clouds.visible = false;
      (this.waterMat.uniforms.uCloudInfo.value as THREE.Vector3).z = 0;
      return 0.2;
    }
    this.viewNearOverride = -1; this.viewFarOverride = -1;
    e.uFlat.value = 0;
    this.clouds.visible = true;

    // --- sky colors -----------------------------------------------------------
    const dayK = smooth(-0.22, 0.28, sunY);           // 0 night .. 1 day
    const duskK = Math.pow(Math.max(0, 1 - Math.abs(sunY) / 0.42), 1.4); // sunrise/sunset
    const clear = 1 - Math.min(1, weatherDark * 1.6);
    const zen = e.uZenith.value, hor = e.uHorizon.value;
    zen.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, dayK);
    hor.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, dayK);
    hor.lerp(DUSK_HAZE, duskK * 0.3 * clear * (0.4 + 0.6 * dayK));
    if (weatherDark > 0) {
      const w = Math.min(1, weatherDark * 1.7);
      const lvl = 0.25 + 0.75 * dayK;
      zen.lerp(this.tmpC.copy(RAIN_ZENITH).multiplyScalar(lvl), w * 0.85);
      hor.lerp(this.tmpC.copy(RAIN_HORIZON).multiplyScalar(lvl), w * 0.85);
    }
    if (flash > 0) { zen.lerp(FLASH_WHITE, flash); hor.lerp(FLASH_WHITE, flash); }
    e.uSunDir.value.set(sunX, sunY, 0);
    e.uGlowAmt.value = duskK * clear * (sunY > -0.3 ? 1 : 0);
    e.uGlow.value.copy(SUNSET_GLOW);
    e.uGlint.value = dayK * clear;

    // --- light colors ---------------------------------------------------------
    const sl = e.uSkyLight.value;
    sl.copy(SKY_NIGHT_LIGHT).lerp(SKY_DAY_LIGHT, dayK);
    sl.lerp(this.tmpC.copy(SKY_DUSK_LIGHT).multiplyScalar(0.25 + 0.75 * dayK), duskK * 0.55 * clear);
    sl.multiplyScalar(1 - weatherDark * 0.55);
    if (flash > 0) sl.lerp(FLASH_WHITE, flash * 0.6);
    e.uAmbient.value.setRGB(0.026, 0.026, 0.034);
    this.hemi.intensity = 0.25 + light * 0.75;
    this.dir.intensity = 0.1 + light * 0.5;
    this.setHeldLightLevel(0.3 + light * 0.7);

    // entity fog (three's Fog): the sky color along the current view heading
    this.camera.getWorldDirection(this.tmpV);
    this.tmpV.y = 0;
    if (this.tmpV.lengthSq() < 1e-6) this.tmpV.set(1, 0, 0);
    this.tmpV.normalize();
    this.skyColorCPU(this.tmpV, this.fog.color);

    // sun and moon ride a great circle around the camera
    const R = 400;
    const cp = this.camera.position;
    this.sun.position.set(cp.x + sunX * R, cp.y + sunY * R, cp.z);
    this.sun.lookAt(cp);
    this.sunHalo.position.copy(this.sun.position);
    this.sunHalo.quaternion.copy(this.sun.quaternion);
    this.moon.position.set(cp.x - sunX * R, cp.y - sunY * R, cp.z);
    this.moon.lookAt(cp);
    const skyVis = weatherDark < 0.6;
    this.sun.visible = sunY > -0.2 && skyVis;
    this.sunHalo.visible = this.sun.visible;
    this.moon.visible = sunY < 0.2 && skyVis;
    // the sun warms and swells toward the horizon
    const sm = this.sun.material as THREE.MeshBasicMaterial;
    sm.color.setRGB(1, 0.85 + 0.15 * (1 - duskK), 0.7 + 0.3 * (1 - duskK)).multiplyScalar(clear * 0.8 + 0.2);
    (this.sunHalo.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.8 + 0.2 * (1 - duskK), 0.6 + 0.4 * (1 - duskK))
      .multiplyScalar((0.7 + duskK * 0.8) * clear);
    this.sunHalo.scale.setScalar(1 + duskK * 0.6);
    (this.moon.material as THREE.MeshBasicMaterial).opacity = clear * (1 - dayK * 0.7);

    // stars fade in at dusk, twinkle, and wheel with the sun
    this.stars.visible = true;
    this.starsMat.uniforms.uStarAlpha.value = Math.max(0, 1 - dayK * 1.6) * clear;
    this.stars.position.copy(cp);
    this.stars.rotation.set(0, 0, ang);

    // clouds: world-anchored, drifting, tinted by the day cycle
    const S = Renderer.CLOUD_CELL, P = Renderer.CLOUD_N * S;
    const drift = (elapsed * 1.1) % P;
    const ox = Math.floor((camX - drift - P / 2) / P) * P + drift;
    const oz = Math.floor((camZ - P / 2) / P) * P;
    this.clouds.position.set(ox, Renderer.CLOUD_Y, oz);
    this.clouds.updateMatrix();
    const reach = Renderer.CLOUD_FAR + Renderer.CLOUD_TILE * S * 0.72;
    for (const t of this.cloudTiles) {
      const vis = Math.hypot(ox + t.cx - camX, oz + t.cz - camZ) < reach;
      t.meshes[0].visible = vis; t.meshes[1].visible = vis;
    }
    const cu = this.cloudMat.uniforms;
    const cc = cu.uCloudCol.value as THREE.Color;
    cc.copy(CLOUD_NIGHT).lerp(CLOUD_DAY, dayK);
    cc.lerp(this.tmpC.copy(CLOUD_DUSK).multiplyScalar(0.3 + 0.7 * dayK), duskK * 0.6 * clear);
    if (weatherDark > 0) cc.lerp(this.tmpC.copy(CLOUD_RAIN).multiplyScalar(0.2 + 0.8 * dayK), Math.min(1, weatherDark * 1.8));
    if (flash > 0) cc.lerp(FLASH_WHITE, flash);
    cu.uCloudAlpha.value = 0.8 + weatherDark * 0.35;
    (this.waterMat.uniforms.uCloudInfo.value as THREE.Vector3).set(ox, oz, Math.min(1, cu.uCloudAlpha.value) * 0.85);
    return light;
  }

  private viewNearOverride = -1;
  private viewFarOverride = -1;

  /** CPU mirror of the GLSL skyColor(), for three's entity fog. */
  private skyColorCPU(d: THREE.Vector3, out: THREE.Color): THREE.Color {
    const e = this.env;
    const up = Math.max(0, Math.min(1, d.y));
    out.copy(e.uHorizon.value).lerp(e.uZenith.value, 1 - Math.pow(1 - up, 3));
    const s = Math.max(0, d.dot(e.uSunDir.value));
    const low = 1 - smooth(-0.1, 0.42, d.y);
    const glow = e.uGlowAmt.value * (Math.pow(s, 6) * 0.85 + s * s * 0.16) * low;
    out.lerp(e.uGlow.value, Math.max(0, Math.min(0.92, glow)));
    if (e.uFlat.value > 0) out.lerp(e.uFlatCol.value, e.uFlat.value);
    return out;
  }

  private setHeldLightLevel(k: number): void {
    this.heldLight.intensity = 1.5 * k;
    this.heldDir.intensity = 1.3 * k;
  }

  // --- held item / arm ------------------------------------------------------

  setHeldItem(id: number, mob?: string): void {
    if (id === this.heldId && mob === this.heldMob) return;
    this.heldId = id;
    this.heldMob = mob;
    this.heldIsOrb = false;
    if (this.heldMesh && this.orbRig) {
      // the orb (and a captive figurine's multi-material boxes) frees itself
      this.heldGroup.remove(this.heldMesh);
      disposeOrb(this.heldMesh);
      this.heldMesh = null;
    }
    this.orbRig = null;
    this.raiseT = 0; // animate the new item up into view
    if (this.heldMesh) {
      this.heldGroup.remove(this.heldMesh);
      this.heldMesh.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && !this.bowGeos.includes(m.geometry)) m.geometry.dispose();
        const mat = m.material as THREE.Material | undefined;
        if (mat) {
          const map = (mat as THREE.MeshBasicMaterial).map;
          if (map && map !== this.atlas.texture) map.dispose();
          mat.dispose();
        }
      });
      this.heldMesh = null;
    }
    for (const g of this.bowGeos) g.dispose();
    this.bowGeos = [];
    this.bowStage = -1;
    this.heldIdleRot.set(0, 0, 0);
    this.heldRestPos.set(0, 0, 0);
    if (id !== 0 && hasDef(id) && (def(id).name === 'bed' || BLOCK_SPRITE_ICONS.has(def(id).name))) {
      // the bed holds as its extruded item sprite (a real little 3/4-view bed),
      // which reads far better in hand than a textured 9/16 slab
      const sprite = this.atlas.sprite(def(id).name);
      const mesh = sprite
        ? new THREE.Mesh(extrudeSpriteGeometry(sprite, 0.28), new THREE.MeshLambertMaterial({ vertexColors: true }))
        : new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.3), new THREE.MeshLambertMaterial({ color: 0xb02e2e }));
      // 3/4 turn so the extruded bed shows its depth; raised clear of the frame
      this.heldIdleRot.set(0.12, -0.55, -0.06);
      this.heldRestPos.set(-0.03, 0.1, 0);
      mesh.rotation.copy(this.heldIdleRot);
      this.heldMesh = mesh;
    } else if (id !== 0 && hasDef(id) && def(id).block && !def(id).opaque && !def(id).solid) {
      // cutout decorations (torch, flowers): hold the tile extruded like an item
      const d = def(id);
      const tile = this.atlas.tileCanvas(d.faces!.sides);
      const { mesh, zc } = this.buildExtrudedItem(tile, 0.4);
      this.heldIdleRot.set(HELD_TILT, HELD_TURN, zc);
      mesh.rotation.copy(this.heldIdleRot);
      this.heldMesh = mesh;
    } else if (id !== 0 && hasShapedItemModel(id)) {
      // slabs, stairs, fences, anvils ... hold as their real little model
      const mesh = new THREE.Mesh(shapedItemGeometry(id, this.atlas)!,
        new THREE.MeshLambertMaterial({ map: this.atlas.texture, alphaTest: 0.35, vertexColors: true }));
      mesh.scale.setScalar(0.2);
      this.heldRestPos.set(-0.02, 0.14, 0);
      this.heldIdleRot.set(0.3, -1.12, 0);
      mesh.rotation.copy(this.heldIdleRot);
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
      // bake Minecraft's face shading (top bright, the two visible sides at
      // different strengths) so the cube reads as 3D under the flat fill light
      const faceShade = [0.64, 0.82, 1, 0.5, 0.82, 0.64];
      const cols: number[] = [];
      for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) cols.push(faceShade[f], faceShade[f], faceShade[f]);
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: this.atlas.texture, alphaTest: 0.35, vertexColors: true }));
      mesh.scale.setScalar(0.2);
      this.heldRestPos.set(-0.02, 0.14, 0);
      // Minecraft's held block: a corner turned toward the eye (the rig sits
      // right of the view axis, so the turn is past 45 degrees) and tipped
      // forward so the top and two side faces all show
      this.heldIdleRot.set(0.3, -1.12, 0);
      mesh.rotation.copy(this.heldIdleRot);
      this.heldMesh = mesh;
    } else if (id === I.MOB_CATCHER || id === I.MOB_CATCHER_FILLED) {
      // the capture orb is a real little 3D ball (layered glass dome, metal
      // band, glowing button; a filled one shows its captive inside), not a
      // flat extruded card — it bobs and turns gently in the hand
      const orb = this.buildCatcherOrb(id === I.MOB_CATCHER_FILLED ? this.heldMob : undefined);
      this.heldMesh = orb;
      this.heldIsOrb = true;
    } else if (id !== 0 && hasDef(id) && (def(id).sprite || spriteNameFor(id, this.heldMob))) {
      // pixel sprite extruded into a real 3D voxel model (Minecraft-style),
      // so tools/items in hand read with depth instead of as a flat card.
      const sprite = this.atlas.sprite(spriteNameFor(id, this.heldMob) ?? def(id).sprite!);
      const isBow = !!def(id).bow;
      const isShield = def(id).name === 'shield';
      let zc = 0;
      let mesh: THREE.Mesh;
      if (sprite && isShield) {
        // the shield is held upright at the right edge, its face turned a
        // little toward the centre (Minecraft's off-guard shield pose)
        mesh = new THREE.Mesh(extrudeSpriteGeometry(sprite, 0.36), new THREE.MeshLambertMaterial({ vertexColors: true }));
        this.heldIdleRot.set(0.05, -0.62, 0);
        this.heldRestPos.set(0.03, 0.13, 0.02);
        mesh.rotation.copy(this.heldIdleRot);
        this.heldMesh = mesh;
        this.heldMesh.position.copy(this.heldRestPos);
        this.heldGroup.add(this.heldMesh);
        return;
      }
      if (sprite && !isBow) {
        const built = this.buildExtrudedItem(sprite, 0.4, 0.3);
        mesh = built.mesh;
        zc = built.zc;
        // compact items (food, gems, buckets) sit higher so the whole sprite
        // shows instead of being clipped by the bottom of the screen
        if (!spriteAxis(sprite).long) this.heldRestPos.set(-0.03, 0.08, 0);
      } else if (sprite) {
        // the bow keeps its idle sprite plus Minecraft's three pulling frames;
        // the draw pose swaps between them as the string comes back
        const frames = ['bow', 'bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2'];
        this.bowGeos = frames.map((n) => extrudeSpriteGeometry(this.atlas.sprite(n) ?? sprite, 0.36));
        mesh = new THREE.Mesh(this.bowGeos[0], new THREE.MeshLambertMaterial({ vertexColors: true }));
        zc = Math.PI / 4 - spriteAxis(sprite).angle;
        this.heldRestPos.set(-0.1, 0.13, -0.04);
      } else {
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicMaterial({ color: 0xff00ff }));
      }
      // Minecraft first-person grip: the sprite's long axis is first spun to a
      // 45-degree diagonal (zc), then the item is turned ~135 degrees about the
      // vertical so its head points up, to the left and away from the player
      // with the handle in the lower-right fist.
      this.heldIdleRot.set(HELD_TILT, HELD_TURN, zc);

      mesh.rotation.copy(this.heldIdleRot);
      this.heldMesh = mesh;
    } else {
      // bare arm: a Steve-sleeve box poking in from the lower right
      const arm = new THREE.Group();
      const skin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.62), new THREE.MeshLambertMaterial({ color: 0xc99672 }));
      arm.add(skin);
      arm.position.set(0.1, -0.14, 0.12);
      arm.rotation.set(0.62, -0.42, 0.2);
      this.heldMesh = arm;
    }
    this.heldMesh.position.copy(this.heldRestPos);
    this.heldGroup.add(this.heldMesh);
  }

  triggerSwing(): void {
    this.swingT = 0;
  }

  /** Hide the first-person hand rig (used while lying in a bed). */
  setHeldVisible(v: boolean): void {
    this.heldGroup.visible = v;
  }

  setBowCharge(charge: number): void {
    this.bowCharge = Math.max(0, Math.min(1, charge));
  }

  /** Raise the held shield into a blocking guard (target 1) or lower it. */
  setBlocking(on: boolean): void {
    this.blockTarget = on ? 1 : 0;
  }

  /** Drive the eating animation: target 1 while chewing, 0 otherwise. */
  setEating(on: boolean): void {
    this.eatTarget = on ? 1 : 0;
  }

  /** Update held-item animation; `moving` drives view bob. */
  updateHeld(dt: number, moving: boolean): void {
    if (this.swingT < 1) this.swingT = Math.min(1, this.swingT + dt / 0.28);
    if (this.raiseT < 1) this.raiseT = Math.min(1, this.raiseT + dt / 0.16);
    this.bobT += dt * (moving ? 7 : 2);
    const s = this.swingT;
    // Minecraft's swing: a quick sqrt-eased arc down and across
    const sw = Math.sin(Math.sqrt(s) * Math.PI);
    const sw2 = Math.sin(s * s * Math.PI);
    const bob = moving ? Math.sin(this.bobT) * 0.012 : Math.sin(this.bobT) * 0.004;
    const bobX = moving ? Math.cos(this.bobT * 0.5) * 0.008 : 0;
    // new item raises into view on a hotbar switch (smoothstep ease)
    const rk = this.raiseT;
    const lower = (1 - rk * rk * (3 - 2 * rk)) * 0.4;
    const drawingBow = this.bowCharge > 0.01 && this.heldId !== 0 && hasDef(this.heldId) && !!def(this.heldId).bow;

    if (drawingBow) {
      const pull = this.bowCharge;
      // swap in the matching pulling frame (Minecraft: 0 / 0.65 / 0.9 draw)
      const stage = pull < 0.65 ? 1 : pull < 0.9 ? 2 : 3;
      const mesh = this.heldMesh as THREE.Mesh | null;
      if (mesh && this.bowGeos.length === 4 && stage !== this.bowStage) {
        mesh.geometry = this.bowGeos[stage];
        this.bowStage = stage;
      }
      // bow raised in front, right of the crosshair, face-on with its upper
      // left tipped away so the nocked arrow points in toward the crosshair;
      // a faint tremble builds as the draw is held at full strength
      const shake = pull >= 0.9 ? Math.sin(this.bobT * 9) * 0.004 : 0;
      this.heldGroup.position.set(0.17 + shake, -0.17 + bob * 0.1 - lower * 0.5, -0.56 + pull * 0.03);
      this.heldGroup.rotation.set(0, 0, 0);
      if (mesh) {
        mesh.scale.setScalar(0.8 + pull * 0.05);
        mesh.rotation.set(-0.42, -0.52, 0.02);
        mesh.position.set(0, 0, 0);
      }
      return;
    }

    if (this.bowGeos.length && this.heldMesh) {
      const mesh = this.heldMesh as THREE.Mesh;
      if (this.bowStage !== 0) { mesh.geometry = this.bowGeos[0]; this.bowStage = 0; }
      mesh.scale.setScalar(1);
      mesh.rotation.copy(this.heldIdleRot);
      mesh.position.copy(this.heldRestPos);
    }

    // eating: lift the food toward the mouth and nudge it with each chew
    this.eatAmt += (this.eatTarget - this.eatAmt) * Math.min(1, dt * 10);
    if (this.eatAmt > 0.01) {
      this.eatPhase += dt * 22;
      const e = this.eatAmt;
      const chew = Math.sin(this.eatPhase) * 0.05 * e;            // quick bite jitter
      this.heldGroup.position.set(
        0.36 - e * 0.2,
        -0.34 + bob - lower + e * 0.1 + chew,                     // rise toward the face
        -0.6 + e * 0.08,                                          // a touch closer
      );
      this.heldGroup.rotation.set(
        -0.1 - e * 0.35 + chew * 1.6,                             // tilt food toward mouth
        0.1 + e * 0.3,
        0.05,
      );
      if (this.heldMesh) this.heldMesh.rotation.copy(this.heldIdleRot);
      return;
    }

    // shield guard: swing the shield in toward the centre, face-on to the view
    this.blockAmt += (this.blockTarget - this.blockAmt) * Math.min(1, dt * 14);
    if (this.blockAmt > 0.01) {
      const b = this.blockAmt;
      this.heldGroup.position.set(0.42 - b * 0.4, -0.36 + bob - lower - b * 0.04, -0.62 - b * 0.3);
      this.heldGroup.rotation.set(0, 0.25 + b * 0.15, 0);
      if (this.heldMesh) {
        const k = 1 - b;
        this.heldMesh.rotation.set(this.heldIdleRot.x * k, this.heldIdleRot.y * k + b * 0.2, this.heldIdleRot.z * k);
      }
      return;
    }

    // rest pose: lower-right of the view, like Minecraft's right hand
    this.heldGroup.position.set(
      0.45 - sw * 0.22 + bobX,
      -0.4 + bob + sw2 * 0.06 - sw * 0.1 - lower,
      -0.62 - sw * 0.08,
    );
    this.heldGroup.rotation.set(
      -sw * 0.95 + bob * 2,
      sw2 * 0.35,
      sw * 0.3,
    );
    if (this.heldIsOrb && this.heldMesh && this.orbRig) this.animateHeldOrb(dt);
  }

  /** Play the held orb's wind-up -> throw -> follow-through (the thrown orb
   *  leaves the hand at ORB_RELEASE, matching EntityManager's launch delay). */
  triggerOrbThrow(): void {
    this.orbThrowT = 0;
  }

  /** Held orb: floats and sways in the palm with a breathing button glow; on a
   *  throw it cocks back (spinning up), snaps forward and vanishes from the
   *  hand, then the next orb rises back into the palm. */
  private animateHeldOrb(dt: number): void {
    const rig = this.orbRig!, mesh = this.heldMesh!;
    this.orbT += dt;
    if (this.orbThrowT < 1) this.orbThrowT = Math.min(1, this.orbThrowT + dt / ORB_THROW_TIME);
    const u = this.orbThrowT;
    const ease = (k: number): number => k * k * (3 - 2 * k);
    // idle: lifted + pulled in so the whole ball shows, floating and swaying
    let px = -0.1, py = 0.18 + Math.sin(this.orbT * 1.7) * 0.01, pz = 0.02;
    let rx = 0.2 + Math.sin(this.orbT * 1.1) * 0.05, rz = Math.sin(this.orbT * 0.8) * 0.06;
    let scale = 1, spinRate = 0, flare = 0;
    if (u < ORB_WIND) {
      // wind-up: draw back, up and out to the right, tipping back, spinning up
      const k = ease(u / ORB_WIND);
      px += 0.07 * k; py += 0.08 * k; pz += 0.12 * k; rx -= 0.8 * k; rz -= 0.3 * k;
      spinRate = 16 * k; flare = k;
    } else if (u < ORB_RELEASE + 0.1) {
      // the throw: whip forward and down toward the crosshair; the orb leaves
      const j = (u - ORB_WIND) / (ORB_RELEASE + 0.1 - ORB_WIND);
      const k = ease(Math.min(1, j * 1.4));
      px += 0.07 - 0.2 * k; py += 0.08 - 0.13 * k; pz += 0.12 - 0.5 * k; rx += -0.8 + 1.6 * k; rz += -0.3 + 0.3 * k;
      spinRate = 16; flare = 1 - k;
      if (u >= ORB_RELEASE) scale = 0;
    } else if (u < 1) {
      // follow-through: the empty hand settles, then the next orb rises in
      const f = (u - ORB_RELEASE - 0.1) / (1 - ORB_RELEASE - 0.1);
      const back = 1 - ease(Math.min(1, f * 1.6));
      px -= 0.13 * back; py -= 0.05 * back; pz -= 0.38 * back; rx += 0.8 * back;
      scale = f < 0.4 ? 0 : ease((f - 0.4) / 0.6);
      py -= (1 - scale) * 0.12;
    }
    const full = this.heldId === I.MOB_CATCHER_FILLED;
    if (spinRate > 0) this.orbSpin += dt * spinRate;
    else if (!full) this.orbSpin += dt * 0.9;       // an empty orb turns lazily
    else {
      // a full one turns back so its captive faces you
      this.orbSpin = Math.atan2(Math.sin(this.orbSpin), Math.cos(this.orbSpin));
      this.orbSpin *= 1 - Math.min(1, dt * 3);
    }
    rig.spin.rotation.y = full && spinRate === 0 ? this.orbSpin + Math.sin(this.orbT * 0.7) * 0.5 : this.orbSpin;
    mesh.position.set(px, py, pz);
    mesh.rotation.set(rx, 0, rz);
    mesh.scale.setScalar(Math.max(0.001, scale));
    // the button breathes (quicker when something is inside) and flares on a wind-up
    const pulse = 0.5 + 0.5 * Math.sin(this.orbT * (full ? 4.2 : 2.2));
    (rig.halo.material as THREE.SpriteMaterial).opacity = Math.min(1, 0.35 + pulse * 0.4 + flare * 0.5);
    rig.halo.scale.setScalar(rig.R * (1 + pulse * 0.25 + flare * 0.8));
  }

  /** Extruded pixel item with its pivot moved to the grip (the low end of the
   *  sprite's long axis). Returns the in-plane spin `zc` that lays that axis on
   *  the 45-degree diagonal Minecraft's own item sprites use, so vertical,
   *  horizontal and diagonal sprites all sit the same way in the fist. */
  private buildExtrudedItem(sprite: HTMLCanvasElement, size: number, roundSize = size): { mesh: THREE.Mesh; zc: number } {
    const name = this.heldId !== 0 && hasDef(this.heldId) ? def(this.heldId).name : '';
    // golden apples/carrots are food, not metal
    const isMetallic = !(hasDef(this.heldId) && def(this.heldId).food) &&
      (name.includes('iron') || name.includes('gold') || name.includes('diamond'));
    // Lambert/Phong with vertex colors: lit by the overlay lights (a metallic
    // PBR material rendered black here — there is no environment to reflect)
    const mat = isMetallic
      ? new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 60, specular: 0x4a4a4a })
      : new THREE.MeshLambertMaterial({ vertexColors: true });
    const ax = spriteAxis(sprite);
    // long tools/weapons hold large; compact items (food, gems) smaller
    if (!ax.long) size = roundSize;
    const geo = extrudeSpriteGeometry(sprite, size);
    const s = size / sprite.width;
    geo.translate(-ax.gx * s, -ax.gy * s, 0);
    return { mesh: new THREE.Mesh(geo, mat), zc: Math.PI / 4 - ax.angle };
  }

  /** A held capture orb (see CatcherOrb): a filled one carries a little
   *  figurine of its captive standing under the glass, lit in its colour. */
  private buildCatcherOrb(mob?: string): THREE.Group {
    // the held rig sits ~0.6 from the eye: 0.24 across reads as a ball in the
    // palm without blocking the view
    const R = 0.12;
    let fig: THREE.Object3D | undefined;
    if (mob) {
      this.orbModels ??= new MobModels();
      try {
        fig = fitFigurine(this.orbModels.build(mob as MobKind).mesh, R);
      } catch {
        fig = undefined; // unknown kind: an empty-looking but lit orb
      }
    }
    const rig = buildOrbRig(R, mob ? (ORB_GLOW[mob] ?? ORB_IDLE_GLOW) : ORB_IDLE_GLOW, fig);
    if (mob) {
      // the captive's colour glows up from the floor of the orb
      const c = new THREE.Color(ORB_GLOW[mob] ?? ORB_IDLE_GLOW);
      rig.floor.color.copy(c).multiplyScalar(0.35);
      // (tinted emissive rather than a point light: adding a light would
      // recompile every overlay shader mid-game)
      fig?.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
        if (m && 'emissive' in m) m.emissive.copy(c).multiplyScalar(0.12);
      });
    }
    this.orbRig = rig;
    return rig.root;
  }

  // --- frame ----------------------------------------------------------------

  /** Draw the frame. `medium` is where the eye is: under water, in lava, or
   *  in air (a boolean `true` still means water, for older callers). */
  render(medium: boolean | 'water' | 'lava' | 'air'): void {
    const e = this.env;
    if (this.minAmbient > 0) { // Night Vision: lift the dark floor (updateEnvironment resets it each frame)
      const a = e.uAmbient.value, k = this.minAmbient;
      a.setRGB(Math.max(a.r, k), Math.max(a.g, k), Math.max(a.b, k * 1.04));
    }
    const m = medium === true ? 'water' : medium === false ? 'air' : medium;
    let near = this.viewNearOverride >= 0 ? this.viewNearOverride : this.viewNear;
    let far = this.viewFarOverride >= 0 ? this.viewFarOverride : this.viewFar;
    const savedFlat = e.uFlat.value;
    const savedFlatCol = this.tmpC2.copy(e.uFlatCol.value);
    if (m === 'water') {
      e.uFlat.value = 1;
      e.uFlatCol.value.copy(WATER_FOG).multiplyScalar(0.12 + this.daylight * 0.88);
      e.uTintMul.value.setRGB(0.55, 0.8, 1.0);
      e.uUnder.value = 1;
      near = 0; far = 26;
    } else if (m === 'lava') {
      e.uFlat.value = 1;
      e.uFlatCol.value.copy(LAVA_FOG);
      e.uTintMul.value.setRGB(1.0, 0.55, 0.3);
      near = 0; far = 3;
    }
    e.uFogNear.value = near;
    e.uFogFar.value = far;
    e.uFogVert.value = m === 'air' ? 0.4 : 1;
    this.fog.near = near;
    this.fog.far = far;
    if (m !== 'air') this.fog.color.copy(e.uFlatCol.value);
    // sky objects can't be seen from inside a liquid
    const skyObjs = this.skyObjs;
    let hidden = 0;
    if (m !== 'air') {
      for (let i = 0; i < skyObjs.length; i++) if (skyObjs[i].visible) { skyObjs[i].visible = false; hidden |= 1 << i; }
    }
    this.three.clear();
    this.three.render(this.scene, this.camera);
    if (m !== 'air') {
      e.uFlat.value = savedFlat;
      e.uFlatCol.value.copy(savedFlatCol);
      e.uTintMul.value.setRGB(1, 1, 1);
      e.uUnder.value = 0;
      for (let i = 0; i < skyObjs.length; i++) if (hidden & (1 << i)) skyObjs[i].visible = true;
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

/** Per-mesh fade value -> shared material uniform (re-uploaded only on change). */
function chunkBeforeRender(this: THREE.Mesh, _r: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera,
  _g: THREE.BufferGeometry, material: THREE.Material): void {
  const mat = material as THREE.ShaderMaterial;
  const f = this.userData.fade as number;
  const u = mat.uniforms.uFade;
  if (u.value !== f) { u.value = f; mat.uniformsNeedUpdate = true; }
}

/** Repeating nearest-filtered map of the cloud cells (red 1 = cloud). */
function cloudMapTexture(cell: Uint8Array, n: number): THREE.DataTexture {
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) { data[i * 4] = cell[i] ? 255 : 0; data[i * 4 + 3] = 255; }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
