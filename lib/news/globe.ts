// Orthographic globe maths, shared by the SVG renderer and its tests. No DOM access here.

export const VIEW = 800; // SVG viewBox size
export const CENTER = VIEW / 2;
export const RADIUS = 370;

const RAD = Math.PI / 180;

export type Projected = {
  /** SVG coordinates in the 800x800 viewBox. */
  x: number;
  y: number;
  /** True on the front hemisphere. */
  visible: boolean;
  /** cos of the angle from the view centre: 1 at the centre, 0 on the limb, negative behind. */
  depth: number;
};

/**
 * Orthographic projection of a point onto a globe whose view is centred on (centerLon, tilt),
 * where tilt is the latitude at the centre of the view.
 */
export function project(lat: number, lon: number, centerLon: number, tilt: number, radius = RADIUS): Projected {
  const phi = lat * RAD;
  const phi0 = tilt * RAD;
  const dl = (lon - centerLon) * RAD;
  const depth = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dl);
  const x = radius * Math.cos(phi) * Math.sin(dl);
  const y = radius * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dl));
  return { x: CENTER + x, y: CENTER - y, visible: depth > 0, depth };
}

/** Marker opacity: 1 across most of the front, fading to 0 near the limb. */
export function markerOpacity(depth: number): number {
  return Math.min(1, Math.max(0, (depth - 0.05) / 0.25));
}

/** Smallest signed difference between two longitudes, in (-180, 180]. */
export function angleDelta(from: number, to: number): number {
  const d = ((((to - from) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Latitude the view can tilt to; keeps the globe from flipping over the poles. */
export const MAX_TILT = 60;

export function clampTilt(lat: number): number {
  return Math.max(-MAX_TILT, Math.min(MAX_TILT, lat));
}

export type View = { lon: number; tilt: number };

/**
 * One animation frame of easing toward a target: moves `rate` of the remaining distance
 * (longitude by the short way round) and snaps once within `epsilon` degrees.
 */
export function easeView(view: View, target: View, rate = 0.12, epsilon = 0.05): { view: View; done: boolean } {
  const dLon = angleDelta(view.lon, target.lon);
  const dTilt = target.tilt - view.tilt;
  if (Math.abs(dLon) < epsilon && Math.abs(dTilt) < epsilon) return { view: { ...target }, done: true };
  return { view: { lon: wrapLon(view.lon + dLon * rate), tilt: view.tilt + dTilt * rate }, done: false };
}

// ---- Drag, inertia and auto-rotation ------------------------------------------------------------

export const DRAG_DEG_PER_PX = 0.4;
export const CLICK_THRESHOLD_PX = 5;
export const INERTIA_DECAY = 0.95; // per 60 fps frame
export const INERTIA_STOP = 0.02; // deg per frame below which inertia ends
export const AUTO_ROTATE_DELAY_MS = 2500;
export const AUTO_ROTATE_RAMP_MS = 1500;

/** A pointer that moved less than the threshold is a click, not a drag. */
export function isClick(dx: number, dy: number, threshold = CLICK_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) < threshold;
}

/**
 * View after dragging (dx, dy) pixels from `origin`. The surface follows the pointer: dragging right
 * turns the globe so the centre longitude decreases; dragging down tilts toward the north.
 */
export function dragView(origin: View, dx: number, dy: number, degPerPx = DRAG_DEG_PER_PX): View {
  return { lon: wrapLon(origin.lon - dx * degPerPx), tilt: clampTilt(origin.tilt + dy * degPerPx) };
}

/** Pointer movement in pixels over `ms` milliseconds -> view velocity in degrees per 60 fps frame. */
export function releaseVelocity(dx: number, dy: number, ms: number, degPerPx = DRAG_DEG_PER_PX): View {
  const frames = Math.max(ms, 1) / (1000 / 60);
  return { lon: (-dx * degPerPx) / frames, tilt: (dy * degPerPx) / frames };
}

/** One inertia step over `frames` 60 fps frames: the view moves, the velocity decays by 0.95 per frame. */
export function stepInertia(view: View, velocity: View, frames = 1, decay = INERTIA_DECAY): { view: View; velocity: View; done: boolean } {
  const factor = Math.pow(decay, frames);
  // Sum of the geometric series, so a long frame travels as far as the same number of short ones.
  const travel = decay === 1 ? frames : (1 - factor) / (1 - decay);
  const next = { lon: wrapLon(view.lon + velocity.lon * travel), tilt: clampTilt(view.tilt + velocity.tilt * travel) };
  const slowed = { lon: velocity.lon * factor, tilt: velocity.tilt * factor };
  const done = Math.hypot(slowed.lon, slowed.tilt) < INERTIA_STOP;
  return { view: next, velocity: done ? { lon: 0, tilt: 0 } : slowed, done };
}

/** 0 until the user has been idle for `delay`, then ramps smoothly up to 1 over `ramp`. */
export function autoRotateFactor(idleMs: number, delay = AUTO_ROTATE_DELAY_MS, ramp = AUTO_ROTATE_RAMP_MS): number {
  if (idleMs <= delay) return 0;
  const t = Math.min(1, (idleMs - delay) / ramp);
  return t * t * (3 - 2 * t); // smoothstep
}

// ---- Cost control (PERF-02) ----------------------------------------------------------------------

/** The canvas never renders more than this many device pixels per CSS pixel (3x phones would cost 2.25x the pixels of 2x). */
export const MAX_CANVAS_DPR = 2;

export function canvasDpr(devicePixelRatio: number | undefined, max = MAX_CANVAS_DPR): number {
  const dpr = devicePixelRatio && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, max);
}

/** Devices with this many logical cores or fewer rotate by themselves at 30 fps instead of 60. */
export const LOW_POWER_CORES = 4;

/** `cores` is navigator.hardwareConcurrency, which is undefined in some browsers: then assume a capable device. */
export function isLowPowerDevice(cores: number | undefined, limit = LOW_POWER_CORES): boolean {
  return typeof cores === "number" && Number.isFinite(cores) && cores > 0 && cores <= limit;
}

/**
 * 30 fps means a step every 33 ms. A 60 Hz display delivers frames every 16.7 ms, so two frames can add up to
 * 33.2 ms and miss a 33.3 ms threshold by rounding: 30 ms makes the step land every second frame.
 */
export const LOW_POWER_STEP_S = 0.03;

/** Whether auto-rotation should move and repaint now, given the seconds that have passed since its last step. */
export function autoStepDue(secondsSinceStep: number, lowPower: boolean): boolean {
  return !lowPower || secondsSinceStep >= LOW_POWER_STEP_S;
}

const f = (n: number) => Math.round(n * 10) / 10;

/** Land dots in three depth bands as `M x y h0` paths (round caps turn each into a dot). */
export function landPaths(dots: ArrayLike<number>, centerLon: number, tilt: number): [string, string, string] {
  const bands: [string[], string[], string[]] = [[], [], []];
  for (let i = 0; i < dots.length; i += 2) {
    const p = project(dots[i + 1], dots[i], centerLon, tilt);
    if (!p.visible) continue;
    const band = p.depth < 0.33 ? 0 : p.depth < 0.66 ? 1 : 2;
    bands[band].push(`M${f(p.x)} ${f(p.y)}h0`);
  }
  return [bands[0].join(""), bands[1].join(""), bands[2].join("")];
}

/** Path for a lat/lon polyline, broken wherever it passes behind the globe. */
export function polylinePath(points: [lat: number, lon: number][], centerLon: number, tilt: number): string {
  let d = "";
  let pen = false;
  for (const [lat, lon] of points) {
    const p = project(lat, lon, centerLon, tilt);
    if (!p.visible) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${f(p.x)} ${f(p.y)}`;
    pen = true;
  }
  return d;
}

/** Graticule every `step` degrees (meridians and parallels). */
export function graticulePath(centerLon: number, tilt: number, step = 30): string {
  let d = "";
  for (let lon = -180; lon < 180; lon += step) {
    const line: [number, number][] = [];
    for (let lat = -90; lat <= 90; lat += 5) line.push([lat, lon]);
    d += polylinePath(line, centerLon, tilt);
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    const line: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 5) line.push([lat, lon]);
    d += polylinePath(line, centerLon, tilt);
  }
  return d;
}
