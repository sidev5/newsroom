"use client";

import { geoContains, geoGraticule, geoOrthographic, geoPath, type GeoProjection } from "d3-geo";
import type { Feature, Geometry } from "geojson";
import { useEffect, useReducer, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import { COUNTRY_POLYGON_IDS } from "@/lib/geo/country-ids";
import { tint } from "@/lib/news/color";
import {
  AUTO_ROTATE_DELAY_MS,
  autoRotateFactor,
  autoStepDue,
  canvasDpr,
  clampTilt,
  dragView,
  easeView,
  isClick,
  isLowPowerDevice,
  markerOpacity,
  project,
  RADIUS,
  releaseVelocity,
  stepInertia,
  VIEW,
  wrapLon,
  type View,
} from "@/lib/news/globe";
import {
  activeCountry,
  badgeLabel,
  HOVER_EASING,
  HOVER_MS,
  hoverReducer,
  markerLayer,
  markerScale,
  needsReveal,
  NO_HOVER,
  pausesRotation,
  tooltipCountry,
  tooltipFor,
  type CountryGroup,
  type HoverState,
} from "@/lib/news/markers";

type Props = {
  /** One group per country with published stories. */
  groups: CountryGroup[];
  /** Country of the story open in the reader. */
  selectedCode: string | null;
  /** Country of the feed card under the pointer; its marker is emphasised and brought into view. */
  cardHoverCode: string | null;
  /** Marker or country click: the dashboard opens the story, or a short list when the country has several. */
  onOpenCountry: (code: string) => void;
  /** Called once, when the visitor first drags the globe (the "Drag to rotate" hint then fades). */
  onFirstDrag?: () => void;
  /** False for a static globe (no published stories). */
  animate: boolean;
};

const AUTO_DEG_PER_SECOND = 5;
const KEY_STEP_DEG = 5;
const FLICK_WINDOW_MS = 80; // a release this long after the last move carries no momentum
const DEFAULT_VIEW: View = { lon: 10, tilt: 20 };
const STOPPED: View = { lon: 0, tilt: 0 };

// Palette of the globe.
const OCEAN = ["#9CCBD8", "#5E9BAE", "#3F7488"] as const; // highlight (top left) -> deep (bottom right)
const LAND = "#F3EBDC";
const BORDER = "#C9BC9E";
const GLOW = "rgba(168, 208, 240, 0.9)";
const GLOW_BLUR_PX = 24;
const TINT_STRENGTH = 0.38; // how much of the department colour a country with news takes
const TINT_HOVER_STRENGTH = 0.62;

type CountryFeature = Feature<Geometry, { name: string }>;

// The country outlines are the same for every visitor and render, so fetch them once.
let landPromise: Promise<CountryFeature[]> | undefined;
function loadLand(): Promise<CountryFeature[]> {
  landPromise ??= fetch("/countries-110m.json")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((topology: Topology<{ countries: GeometryCollection<{ name: string }> }>) => feature(topology, topology.objects.countries).features as CountryFeature[])
    .catch(() => {
      landPromise = undefined; // allow a retry on the next mount
      return [];
    });
  return landPromise;
}

/** What does not change from frame to frame: sized per canvas, rebuilt only when the canvas is resized. */
type Paint = {
  key: string;
  /** The atmosphere glow around the sphere, drawn once (a shadowBlur on every frame is the costliest step). */
  glow: HTMLCanvasElement;
  ocean: CanvasGradient;
  shade: CanvasGradient;
  sheen: CanvasGradient;
};

function buildPaint(ctx: CanvasRenderingContext2D, css: number, dpr: number): Paint {
  const c = css / 2;
  const R = (css * RADIUS) / VIEW;

  // Atmosphere: a soft blue-white glow just outside the sphere. (shadowBlur is in device pixels.)
  const glow = document.createElement("canvas");
  glow.width = glow.height = Math.max(1, Math.round(css * dpr));
  const g = glow.getContext("2d");
  if (g) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.shadowColor = GLOW;
    g.shadowBlur = GLOW_BLUR_PX * dpr;
    g.fillStyle = OCEAN[1];
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.fill();
  }

  // Ocean: lit from the top left, deepening toward the bottom right.
  const ocean = ctx.createRadialGradient(c - R * 0.38, c - R * 0.42, R * 0.04, c, c, R * 1.1);
  ocean.addColorStop(0, OCEAN[0]);
  ocean.addColorStop(0.55, OCEAN[1]);
  ocean.addColorStop(1, OCEAN[2]);

  // Depth: a soft dark overlay (about 18%) that gathers toward the lower right, plus a faint sheen top left.
  const shade = ctx.createRadialGradient(c - R * 0.4, c - R * 0.45, R * 0.35, c, c, R * 1.05);
  shade.addColorStop(0, "rgba(22, 52, 62, 0)");
  shade.addColorStop(0.6, "rgba(22, 52, 62, 0.06)");
  shade.addColorStop(1, "rgba(22, 52, 62, 0.18)");
  const sheen = ctx.createRadialGradient(c - R * 0.42, c - R * 0.46, 0, c - R * 0.42, c - R * 0.46, R * 0.7);
  sheen.addColorStop(0, "rgba(255, 255, 255, 0.16)");
  sheen.addColorStop(1, "rgba(255, 255, 255, 0)");

  return { key: `${css}@${dpr}`, glow, ocean, shade, sheen };
}

type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  /** Set once the pointer has moved past the click threshold. */
  engaged: boolean;
  originView: View;
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
  lastT: number;
  /** Most recent pointer step, for momentum on release. */
  step: { dx: number; dy: number; ms: number };
};

export function Globe({ groups, selectedCode, cardHoverCode, onOpenCountry, onFirstDrag, animate }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Marker hover and focus live here; a hovered feed card arrives as a prop.
  const [local, dispatch] = useReducer(hoverReducer, NO_HOVER);
  const hover: HoverState = { ...local, card: cardHoverCode };
  const wasPaused = useRef(false);
  const view = useRef<View>({ ...DEFAULT_VIEW });
  const target = useRef<View | null>(null);
  const velocity = useRef<View>(STOPPED);
  const drag = useRef<Drag | null>(null);
  /** performance.now() of the last user interaction; null = none yet, so rotation starts at once. */
  const lastInteraction = useRef<number | null>(null);
  const land = useRef<CountryFeature[]>([]);
  const projection = useRef<GeoProjection | null>(null);
  const size = useRef({ css: 0, dpr: 1 });
  const paint = useRef<Paint | null>(null);
  const dirty = useRef(true);
  const reduced = useRef(false);
  const dragged = useRef(false);
  /** Country (alpha-2) with news under the pointer, for the highlight and the click. */
  const overCountry = useRef<string | null>(null);
  const prevCode = useRef<string | null>(null);
  const paused = pausesRotation(hover);
  const live = useRef({ groups, selectedCode, animate, paused });

  const markers = useRef(new Map<string, HTMLButtonElement>());

  // Keep the animation loop's view of props current without restarting it.
  useEffect(() => {
    live.current = { groups, selectedCode, animate, paused };
    dirty.current = true;
  }, [groups, selectedCode, animate, paused]);

  // Auto-rotation stops while a marker is emphasised and ramps back up when the pointer leaves.
  useEffect(() => {
    if (wasPaused.current && !paused) lastInteraction.current = performance.now() - AUTO_ROTATE_DELAY_MS;
    wasPaused.current = paused;
  }, [paused]);

  function turnTo(code: string) {
    const g = live.current.groups.find((x) => x.code === code);
    if (!g) return;
    const next = { lon: g.lon, tilt: clampTilt(g.lat) };
    if (reduced.current) {
      view.current = next;
      target.current = null;
      dirty.current = true;
    } else {
      target.current = next;
    }
  }

  // Ease toward the selected story's country; resume rotation when it is cleared.
  useEffect(() => {
    if (!selectedCode || !groups.some((g) => g.code === selectedCode)) {
      target.current = null;
      // Closing the reader: skip the idle delay and just ramp the speed back up.
      if (prevCode.current && !selectedCode) lastInteraction.current = performance.now() - AUTO_ROTATE_DELAY_MS;
    } else {
      turnTo(selectedCode);
    }
    prevCode.current = selectedCode;
    // Only a change of selection should steer the globe, not a re-filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode]);

  // Hovering a feed card: if its country is on the far side, turn the globe to face it.
  useEffect(() => {
    if (!cardHoverCode || selectedCode) return;
    const g = live.current.groups.find((x) => x.code === cardHoverCode);
    if (!g) return;
    const { depth } = project(g.lat, g.lon, view.current.lon, view.current.tilt);
    if (needsReveal(depth)) turnTo(cardHoverCode);
    // Only a change of the hovered card should steer the globe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardHoverCode]);

  useEffect(() => {
    let cancelled = false;
    loadLand().then((features) => {
      if (cancelled) return;
      land.current = features;
      dirty.current = true;
    });

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = mq.matches;
    const onMq = () => (reduced.current = mq.matches);
    mq.addEventListener("change", onMq);

    const proj = geoOrthographic().clipAngle(90).precision(0.6);
    projection.current = proj;
    const graticule = geoGraticule().step([20, 20])();

    // Canvas backing store = CSS size x devicePixelRatio (at most 2), so the edges stay crisp on dense screens
    // without a 3x phone paying for 2.25 times the pixels.
    function resize() {
      const el = canvas.current;
      const box = root.current;
      if (!el || !box) return;
      const css = box.clientWidth;
      const dpr = canvasDpr(window.devicePixelRatio);
      size.current = { css, dpr };
      el.width = Math.max(1, Math.round(css * dpr));
      el.height = el.width;
      paint.current = null; // the glow and gradients are sized for the old canvas
      dirty.current = true;
    }
    resize();
    const ro = new ResizeObserver(resize);
    if (root.current) ro.observe(root.current);
    window.addEventListener("resize", resize); // also fires when browser zoom changes devicePixelRatio

    function drawEarth() {
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (!el || !ctx || size.current.css === 0) return;
      const { css, dpr } = size.current;
      const { lon, tilt } = view.current;
      const c = css / 2;
      const R = (css * RADIUS) / VIEW;

      proj.translate([c, c]).scale(R).rotate([-lon, -tilt]);
      const path = geoPath(proj, ctx);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, css, css);

      if (paint.current?.key !== `${css}@${dpr}`) paint.current = buildPaint(ctx, css, dpr);
      const { glow, ocean, shade, sheen } = paint.current;

      // Atmosphere: copied from the canvas it was drawn on once.
      ctx.drawImage(glow, 0, 0, css, css);

      // Ocean
      ctx.save(); // restored after the land and shading, which are clipped to the sphere
      ctx.fillStyle = ocean;
      ctx.beginPath();
      ctx.arc(c, c, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.clip();

      // Graticule every 20 degrees, white at about 20%.
      ctx.beginPath();
      path(graticule);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
      ctx.lineWidth = 0.6;
      ctx.stroke();

      // Land: ivory countries with thin sand borders; countries with news take a light tint of their colour.
      const tints = new Map<string, { fill: string; hover: string; code: string }>();
      for (const g of live.current.groups) {
        const id = COUNTRY_POLYGON_IDS[g.code];
        if (id) tints.set(id, { fill: tint(g.color, LAND, TINT_STRENGTH), hover: tint(g.color, LAND, TINT_HOVER_STRENGTH), code: g.code });
      }
      ctx.lineJoin = "round";
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = BORDER;
      ctx.beginPath();
      for (const f of land.current) if (!tints.has(String(f.id))) path(f);
      ctx.fillStyle = LAND;
      ctx.fill();
      ctx.stroke();
      for (const f of land.current) {
        const t = tints.get(String(f.id));
        if (!t) continue;
        const hot = overCountry.current === t.code;
        ctx.beginPath();
        path(f);
        ctx.fillStyle = hot ? t.hover : t.fill;
        ctx.fill();
        ctx.lineWidth = hot ? 1.1 : 0.5;
        ctx.strokeStyle = hot ? "#8F8160" : BORDER;
        ctx.stroke();
      }

      // Depth: the shade and the sheen.
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, css, css);
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, css, css);
      ctx.restore();

      ctx.beginPath();
      ctx.arc(c, c, R - 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(63, 116, 136, 0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    function placeMarkers() {
      const { lon, tilt } = view.current;
      for (const g of live.current.groups) {
        const el = markers.current.get(g.code);
        if (!el) continue;
        const p = project(g.lat, g.lon, lon, tilt);
        const opacity = p.visible ? markerOpacity(p.depth) : 0;
        // Percent of the globe box, so markers stay on the sphere at any rendered size.
        el.style.left = `${(p.x / VIEW) * 100}%`;
        el.style.top = `${(p.y / VIEW) * 100}%`;
        el.style.opacity = String(opacity);
        // Markers on the far side are hidden: they leave the tab order and can't be clicked.
        el.style.visibility = opacity > 0 ? "visible" : "hidden";
      }
    }

    // Auto-rotation on a device with 4 cores or fewer moves and repaints at 30 fps. Drag, inertia, easing toward a
    // story and hover scaling are not throttled.
    const lowPower = isLowPowerDevice(navigator.hardwareConcurrency);
    let autoSeconds = 0; // time since auto-rotation last moved the globe

    let raf = 0;
    let last = performance.now();
    function frame(now: number) {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      if (drag.current?.engaged) {
        // The pointer handlers own the view while dragging.
        autoSeconds = 0;
      } else if (target.current) {
        const step = easeView(view.current, target.current);
        view.current = step.view;
        if (step.done) target.current = null;
        dirty.current = true;
        autoSeconds = 0;
      } else if (velocity.current.lon !== 0 || velocity.current.tilt !== 0) {
        const step = stepInertia(view.current, velocity.current, dt * 60);
        view.current = step.view;
        velocity.current = step.velocity;
        dirty.current = true;
        autoSeconds = 0;
      } else if (live.current.animate && !live.current.selectedCode && !live.current.paused && !reduced.current && !drag.current) {
        const idle = lastInteraction.current === null ? Infinity : now - lastInteraction.current;
        const factor = autoRotateFactor(idle);
        autoSeconds += dt;
        if (factor > 0 && autoStepDue(autoSeconds, lowPower)) {
          view.current = { ...view.current, lon: wrapLon(view.current.lon - AUTO_DEG_PER_SECOND * autoSeconds * factor) };
          dirty.current = true;
          autoSeconds = 0;
        } else if (factor === 0) {
          autoSeconds = 0;
        }
      } else {
        autoSeconds = 0;
      }

      if (dirty.current) {
        dirty.current = false;
        drawEarth();
        placeMarkers();
      }
      raf = requestAnimationFrame(frame);
    }

    // The loop runs only while the tab is visible AND the globe is on screen (below 1100 px it sits above the
    // feed and scrolls away). It restarts without a time jump.
    let onScreen = true;
    function start() {
      if (raf || document.hidden || !onScreen) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    function onVisibility() {
      stop();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);

    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              onScreen = entries[entries.length - 1].isIntersecting;
              if (onScreen) start();
              else stop();
            },
            { rootMargin: "100px" },
          );
    if (io && root.current) io.observe(root.current);
    start();

    return () => {
      cancelled = true;
      stop();
      io?.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      mq.removeEventListener("change", onMq);
    };
  }, []);

  /** Alpha-2 code of the country with news under this screen point, or null. Works at any CSS scale. */
  function countryAt(clientX: number, clientY: number): string | null {
    const el = canvas.current;
    const proj = projection.current;
    if (!el || !proj || size.current.css === 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return null;
    const k = size.current.css / rect.width;
    const lonLat = proj.invert?.([(clientX - rect.left) * k, (clientY - rect.top) * k]);
    if (!lonLat || !Number.isFinite(lonLat[0])) return null;
    for (const g of live.current.groups) {
      const id = COUNTRY_POLYGON_IDS[g.code];
      const f = id ? land.current.find((x) => String(x.id) === id) : undefined;
      if (f && geoContains(f, lonLat)) return g.code;
    }
    return null;
  }

  function setOver(code: string | null) {
    if (overCountry.current === code) return;
    overCountry.current = code;
    dirty.current = true;
    if (root.current && !drag.current?.engaged) root.current.style.cursor = code ? "pointer" : "";
  }

  // ---- Pointer drag ----------------------------------------------------------------------------

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A marker press is a click on that marker, never the start of a drag.
    if ((e.target as Element).closest("button")) return;
    const now = performance.now();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      engaged: false,
      originView: view.current,
      originX: e.clientX,
      originY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      lastT: now,
      step: { dx: 0, dy: 0, ms: 16 },
    };
    velocity.current = STOPPED;
    lastInteraction.current = now;
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) {
      // Not pressed: highlight the country under a mouse pointer.
      if (e.pointerType === "mouse" && !(e.target as Element).closest("button")) setOver(countryAt(e.clientX, e.clientY));
      return;
    }
    if (d.pointerId !== e.pointerId) return;
    const now = performance.now();
    lastInteraction.current = now;

    if (!d.engaged) {
      if (isClick(e.clientX - d.startX, e.clientY - d.startY)) return; // still just a press
      d.engaged = true;
      target.current = null; // dragging cancels the ease toward a selected story
      setOver(null);
      if (!dragged.current) {
        dragged.current = true;
        onFirstDrag?.();
      }
      // Measure from where the threshold was crossed, so the globe doesn't jump.
      d.originView = view.current;
      d.originX = e.clientX;
      d.originY = e.clientY;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      d.lastT = now;
      if (root.current) root.current.style.cursor = "grabbing";
      return;
    }

    view.current = dragView(d.originView, e.clientX - d.originX, e.clientY - d.originY);
    d.step = { dx: e.clientX - d.lastX, dy: e.clientY - d.lastY, ms: now - d.lastT };
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.lastT = now;
    dirty.current = true;
  }

  function endDrag(e: PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const now = performance.now();
    drag.current = null;
    lastInteraction.current = now;
    if (root.current) root.current.style.cursor = overCountry.current ? "pointer" : "";
    if (d.engaged && !cancelled && !reduced.current && now - d.lastT < FLICK_WINDOW_MS) {
      velocity.current = releaseVelocity(d.step.dx, d.step.dy, d.step.ms);
    }
    // A press that never became a drag, on a country with news, opens that country.
    if (!d.engaged && !cancelled) {
      const code = countryAt(e.clientX, e.clientY);
      if (code) onOpenCountry(code);
    }
  }

  // ---- Keyboard ----------------------------------------------------------------------------------

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_STEP_DEG, 0],
      ArrowRight: [KEY_STEP_DEG, 0],
      ArrowUp: [0, KEY_STEP_DEG],
      ArrowDown: [0, -KEY_STEP_DEG],
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    target.current = null;
    velocity.current = STOPPED;
    view.current = { lon: wrapLon(view.current.lon + move[0]), tilt: clampTilt(view.current.tilt + move[1]) };
    lastInteraction.current = performance.now();
    dirty.current = true;
  }

  return (
    <div
      ref={root}
      role="group"
      aria-label="Interactive globe. Drag, or use the arrow keys, to rotate."
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setOver(null)}
      onPointerUp={(e) => endDrag(e, false)}
      onPointerCancel={(e) => endDrag(e, true)}
      onKeyDown={onKeyDown}
      className="relative aspect-square w-full cursor-grab touch-none select-none rounded-full focus-visible:outline-offset-8"
    >
      {/* Ground shadow: a very soft ellipse under the sphere. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-[14%] right-[14%] top-[93%] h-[9%] rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(44,53,47,0.26),rgba(44,53,47,0)_70%)] blur-[7px]"
      />
      <canvas ref={canvas} role="img" aria-label="Globe showing where stories come from" className="absolute inset-0 size-full" />

      {groups.map((g) => {
        const selected = g.code === selectedCode;
        const scale = markerScale(g.code, hover);
        const emphasised = scale > 1;
        const tip = tooltipCountry(hover) === g.code ? tooltipFor(g) : null;
        const badge = badgeLabel(g.count);
        return (
          <button
            key={g.code}
            ref={(el) => {
              if (el) markers.current.set(g.code, el);
              else markers.current.delete(g.code);
            }}
            type="button"
            aria-label={`${g.name}: ${g.count} ${g.count === 1 ? "story" : "stories"}. ${g.stories[0].headline}`}
            aria-pressed={selected}
            onClick={() => onOpenCountry(g.code)}
            onPointerEnter={(e) => e.pointerType !== "touch" && dispatch({ type: "marker-enter", code: g.code })}
            onPointerLeave={() => dispatch({ type: "marker-leave", code: g.code })}
            onFocus={() => dispatch({ type: "focus", code: g.code })}
            onBlur={() => dispatch({ type: "blur", code: g.code })}
            style={{ visibility: "hidden", opacity: 0 }}
            className={`absolute grid size-12 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full ${markerLayer(g.code, hover, selected)}`}
          >
            {/* Only this inner box scales, so the 48px hit area and the tooltip stay put. */}
            <span
              data-emphasised={emphasised}
              className="relative grid size-full place-items-center motion-reduce:transition-none"
              style={{ transform: `scale(${scale})`, transition: `transform ${HOVER_MS}ms ${HOVER_EASING}` }}
              aria-hidden="true"
            >
              <span className="marker-ring absolute size-4 rounded-full" style={{ backgroundColor: g.color }} />
              <span
                className={`relative rounded-full border-2 border-white shadow-[0_1px_4px_rgba(31,55,63,0.45)] ${selected ? "size-6" : "size-3.5"}`}
                style={{ backgroundColor: g.color }}
              />
              {badge && (
                <span className="absolute left-[calc(50%+4px)] top-[calc(50%-20px)] grid h-4 min-w-4 place-items-center rounded-full border border-white bg-ink px-1 font-mono text-[10px] font-medium leading-none text-white">
                  {badge}
                </span>
              )}
            </span>

            {tip && (
              <span
                role="tooltip"
                className="pointer-events-none absolute bottom-[calc(50%+22px)] left-1/2 z-10 flex w-56 -translate-x-1/2 flex-col gap-1.5 rounded-[10px] border border-line bg-paper p-3 text-left shadow-[0_8px_24px_rgba(44,53,47,0.18)]"
              >
                <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-meta">{tip.title}</span>
                {tip.headlines.map((h, i) => (
                  <span key={i} className="line-clamp-2 font-headline text-[14px] font-semibold leading-snug text-ink">
                    {h}
                  </span>
                ))}
                {tip.more > 0 && <span className="text-[12px] text-secondary">+{tip.more} more</span>}
              </span>
            )}
            {!tip && selected && !activeCountry(hover) && (
              <span className="pointer-events-none absolute left-1/2 top-[calc(50%+18px)] -translate-x-1/2 whitespace-nowrap rounded bg-ink px-2 py-1 text-xs font-medium text-white">
                {g.name}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
