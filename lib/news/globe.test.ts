import { describe, expect, it } from "vitest";
import {
  angleDelta,
  autoRotateFactor,
  autoStepDue,
  canvasDpr,
  CENTER,
  clampTilt,
  dragView,
  easeView,
  graticulePath,
  isClick,
  isLowPowerDevice,
  landPaths,
  LOW_POWER_STEP_S,
  markerOpacity,
  polylinePath,
  project,
  RADIUS,
  releaseVelocity,
  stepInertia,
  wrapLon,
} from "./globe";

describe("project", () => {
  it("puts the view centre at the middle of the SVG", () => {
    const p = project(20, 10, 10, 20);
    expect(p.x).toBeCloseTo(CENTER);
    expect(p.y).toBeCloseTo(CENTER);
    expect(p.depth).toBeCloseTo(1);
    expect(p.visible).toBe(true);
  });

  it("maps the equator at 90 degrees east of the centre to the right-hand limb", () => {
    const p = project(0, 90, 0, 0);
    expect(p.x).toBeCloseTo(CENTER + RADIUS);
    expect(p.y).toBeCloseTo(CENTER);
    expect(p.depth).toBeCloseTo(0, 5);
  });

  it("maps west to the left and north to the top (SVG y grows downward)", () => {
    expect(project(0, -45, 0, 0).x).toBeLessThan(CENTER);
    expect(project(45, 0, 0, 0).y).toBeLessThan(CENTER);
    expect(project(-45, 0, 0, 0).y).toBeGreaterThan(CENTER);
  });

  it("gives known coordinates (London from a view centred on 0,0)", () => {
    const p = project(51.5, -0.1, 0, 0);
    expect(p.x).toBeCloseTo(CENTER - RADIUS * Math.cos((51.5 * Math.PI) / 180) * Math.sin((0.1 * Math.PI) / 180), 6);
    expect(p.y).toBeCloseTo(CENTER - RADIUS * Math.sin((51.5 * Math.PI) / 180), 6);
    expect(p.visible).toBe(true);
  });

  it("hides the far side", () => {
    expect(project(0, 180, 0, 0).visible).toBe(false);
    expect(project(0, 120, 0, 0).visible).toBe(false);
    expect(project(0, 80, 0, 0).visible).toBe(true);
    // The antipode of the centre is hidden whatever the tilt.
    expect(project(-20, 190, 10, 20).visible).toBe(false);
  });

  it("tilting toward the north shows the pole", () => {
    expect(project(80, 0, 0, 0).y).toBeLessThan(CENTER - RADIUS * 0.9);
    expect(project(80, 0, 0, 60).y).toBeGreaterThan(project(80, 0, 0, 0).y); // pole moves toward the centre
    expect(project(89, 150, 0, 40).visible).toBe(true); // pole stays visible when tilted toward it
  });

  it("stays inside the sphere", () => {
    for (const [lat, lon] of [[10, 80], [-60, 30], [75, -100], [0, 89]] as const) {
      const p = project(lat, lon, 0, 20);
      if (p.visible) expect(Math.hypot(p.x - CENTER, p.y - CENTER)).toBeLessThanOrEqual(RADIUS + 1e-6);
    }
  });

  it("is periodic in longitude", () => {
    const a = project(30, 40, 0, 20);
    const b = project(30, 400, 0, 20);
    expect(b.x).toBeCloseTo(a.x);
    expect(b.y).toBeCloseTo(a.y);
  });
});

describe("markerOpacity", () => {
  it("fades from 0 at the limb to 1 well inside", () => {
    expect(markerOpacity(0)).toBe(0);
    expect(markerOpacity(-0.5)).toBe(0);
    expect(markerOpacity(0.175)).toBeCloseTo(0.5);
    expect(markerOpacity(0.5)).toBe(1);
  });
});

describe("angles and easing", () => {
  it("takes the short way round", () => {
    expect(angleDelta(170, -170)).toBe(20);
    expect(angleDelta(-170, 170)).toBe(-20);
    expect(angleDelta(0, 180)).toBe(180);
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
  });

  it("clamps tilt", () => {
    expect(clampTilt(80)).toBe(60);
    expect(clampTilt(-80)).toBe(-60);
    expect(clampTilt(12)).toBe(12);
  });

  it("moves 12% of the way per frame and snaps within 0.05 degrees", () => {
    const first = easeView({ lon: 0, tilt: 0 }, { lon: 100, tilt: 50 });
    expect(first.view.lon).toBeCloseTo(12);
    expect(first.view.tilt).toBeCloseTo(6);
    expect(first.done).toBe(false);

    let view = { lon: 0, tilt: 20 };
    let frames = 0;
    for (let done = false; !done && frames < 500; frames++) ({ view, done } = easeView(view, { lon: 120, tilt: 45 }));
    expect(view).toEqual({ lon: 120, tilt: 45 });
    expect(frames).toBeLessThan(120);
  });

  it("eases across the antimeridian the short way", () => {
    const { view } = easeView({ lon: 175, tilt: 0 }, { lon: -175, tilt: 0 });
    expect(view.lon).toBeGreaterThan(175);
  });
});

describe("drag", () => {
  it("treats under 5px of movement as a click", () => {
    expect(isClick(0, 0)).toBe(true);
    expect(isClick(3, 3)).toBe(true); // 4.24px
    expect(isClick(5, 0)).toBe(false);
    expect(isClick(-4, 4)).toBe(false); // 5.66px
  });

  it("turns drag pixels into 0.4 degrees: right lowers lon, down raises tilt", () => {
    expect(dragView({ lon: 10, tilt: 20 }, 100, 0)).toEqual({ lon: -30, tilt: 20 });
    expect(dragView({ lon: 10, tilt: 20 }, -100, 0).lon).toBeCloseTo(50);
    expect(dragView({ lon: 0, tilt: 0 }, 0, 50)).toEqual({ lon: 0, tilt: 20 });
    expect(dragView({ lon: 0, tilt: 0 }, 0, -50)).toEqual({ lon: 0, tilt: -20 });
  });

  it("clamps tilt to -60..60 and wraps longitude", () => {
    expect(dragView({ lon: 0, tilt: 50 }, 0, 1000).tilt).toBe(60);
    expect(dragView({ lon: 0, tilt: -50 }, 0, -1000).tilt).toBe(-60);
    expect(dragView({ lon: 170, tilt: 0 }, -100, 0).lon).toBeCloseTo(-150); // 170 + 40 wraps
  });
});

describe("inertia", () => {
  it("derives release velocity in degrees per 60 fps frame", () => {
    const v = releaseVelocity(-100, 0, 100); // 100px left in 100ms = 6 frames
    expect(v.lon).toBeCloseTo((100 * 0.4) / 6);
    expect(v.tilt).toBeCloseTo(0);
  });

  it("decays velocity by 0.95 per frame and moves the view", () => {
    const step = stepInertia({ lon: 0, tilt: 0 }, { lon: 4, tilt: 2 });
    expect(step.velocity.lon).toBeCloseTo(3.8);
    expect(step.velocity.tilt).toBeCloseTo(1.9);
    expect(step.view.lon).toBeCloseTo(4);
    expect(step.view.tilt).toBeCloseTo(2);
    expect(step.done).toBe(false);
  });

  it("travels the same distance in one long frame as in several short ones", () => {
    const one = stepInertia({ lon: 0, tilt: 0 }, { lon: 4, tilt: 0 }, 3);
    let view = { lon: 0, tilt: 0 };
    let velocity = { lon: 4, tilt: 0 };
    for (let i = 0; i < 3; i++) ({ view, velocity } = stepInertia(view, velocity));
    expect(one.view.lon).toBeCloseTo(view.lon);
    expect(one.velocity.lon).toBeCloseTo(velocity.lon);
  });

  it("eases out to a stop and never leaves the tilt range", () => {
    let view = { lon: 0, tilt: 55 };
    let velocity = { lon: 5, tilt: 5 };
    let frames = 0;
    for (let done = false; !done && frames < 1000; frames++) ({ view, velocity, done } = stepInertia(view, velocity));
    expect(frames).toBeLessThan(200);
    expect(view.tilt).toBeLessThanOrEqual(60);
    expect(velocity).toEqual({ lon: 0, tilt: 0 });
  });
});

describe("autoRotateFactor", () => {
  it("waits 2.5 s, then ramps smoothly from 0 to 1", () => {
    expect(autoRotateFactor(0)).toBe(0);
    expect(autoRotateFactor(2500)).toBe(0);
    expect(autoRotateFactor(3250)).toBeCloseTo(0.5); // halfway through the 1.5 s ramp
    expect(autoRotateFactor(4000)).toBe(1);
    expect(autoRotateFactor(60_000)).toBe(1);
    expect(autoRotateFactor(2800)).toBeLessThan(autoRotateFactor(3200)); // monotonic, no snap
  });
});

describe("paths", () => {
  it("draws only front-hemisphere dots, split into depth bands", () => {
    // [lon, lat] pairs: centre (deep), near centre, limb-ish, and the far side.
    const dots = [0, 0, 60, 0, 85, 0, 180, 0];
    const [low, mid, high] = landPaths(dots, 0, 0);
    expect(high.match(/M/g)).toHaveLength(1);
    expect(mid.match(/M/g)).toHaveLength(1);
    expect(low.match(/M/g)).toHaveLength(1);
    expect(high + mid + low).not.toContain("NaN");
    expect(landPaths([180, 0], 0, 0)).toEqual(["", "", ""]);
  });

  it("breaks a polyline where it goes behind the globe", () => {
    const d = polylinePath([[0, -170], [0, -60], [0, 0], [0, 60], [0, 170]], 0, 0);
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d.match(/L/g)).toHaveLength(2);
    const split = polylinePath([[0, -60], [0, 170], [0, 60]], 0, 0);
    expect(split.match(/M/g)).toHaveLength(2);
  });

  it("builds a graticule with only visible segments", () => {
    const d = graticulePath(0, 20);
    expect(d.length).toBeGreaterThan(100);
    expect(d).not.toContain("NaN");
  });
});

describe("canvasDpr (PERF-02)", () => {
  it("passes ordinary ratios through and caps dense screens at 2", () => {
    expect(canvasDpr(1)).toBe(1);
    expect(canvasDpr(1.5)).toBe(1.5);
    expect(canvasDpr(2)).toBe(2);
    expect(canvasDpr(3)).toBe(2);
    expect(canvasDpr(4.5)).toBe(2);
  });

  it("falls back to 1 for a missing or nonsensical ratio", () => {
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(canvasDpr(bad as number)).toBeLessThanOrEqual(2);
    expect(canvasDpr(undefined)).toBe(1);
    expect(canvasDpr(0)).toBe(1);
    expect(canvasDpr(Number.NaN)).toBe(1);
  });

  it("a 3x phone paints 2.25 times fewer pixels than before the cap", () => {
    const css = 390;
    const px = (dpr: number) => Math.round(css * dpr) ** 2;
    expect(px(3) / px(canvasDpr(3))).toBeCloseTo(2.25, 2);
  });
});

describe("isLowPowerDevice", () => {
  it("is true for 4 logical cores or fewer", () => {
    expect(isLowPowerDevice(1)).toBe(true);
    expect(isLowPowerDevice(2)).toBe(true);
    expect(isLowPowerDevice(4)).toBe(true);
  });

  it("is false above 4 cores, and when the browser does not say", () => {
    expect(isLowPowerDevice(5)).toBe(false);
    expect(isLowPowerDevice(8)).toBe(false);
    expect(isLowPowerDevice(undefined)).toBe(false);
    expect(isLowPowerDevice(0)).toBe(false);
    expect(isLowPowerDevice(Number.NaN)).toBe(false);
  });
});

describe("autoStepDue: auto-rotation at 30 fps on low-power devices", () => {
  /** Runs `seconds` of frames at `hz` the way the globe's loop does and returns how many steps it took and the total degrees. */
  function simulate(hz: number, lowPower: boolean, seconds = 2) {
    const dt = 1 / hz;
    let acc = 0;
    let steps = 0;
    let degrees = 0;
    for (let i = 0; i < hz * seconds; i++) {
      acc += dt;
      if (autoStepDue(acc, lowPower)) {
        degrees += 5 * acc; // AUTO_DEG_PER_SECOND * elapsed
        acc = 0;
        steps++;
      }
    }
    return { steps, degrees };
  }

  it("moves on every frame on a capable device", () => {
    expect(simulate(60, false).steps).toBe(120);
  });

  it("moves every second frame (about 30 steps a second) on a 60 Hz display on a low-power device", () => {
    const { steps } = simulate(60, true);
    expect(steps).toBe(60); // 2 s at 30 fps
  });

  it("still rotates at the same speed: a repaint is skipped, the time is not", () => {
    const full = simulate(60, false);
    const low = simulate(60, true);
    expect(low.degrees).toBeCloseTo(full.degrees, 6);
    expect(low.degrees).toBeCloseTo(10, 6); // 5 deg/s for 2 s
  });

  it("does not drop below 30 fps because of rounding on a 60 Hz display", () => {
    expect(autoStepDue(2 / 60, true)).toBe(true);
    expect(autoStepDue(1 / 60, true)).toBe(false);
    expect(LOW_POWER_STEP_S).toBeLessThan(1 / 30);
  });

  it("on a 120 Hz display it steps about every fourth frame, never faster than 30 fps", () => {
    expect(simulate(120, true).steps).toBe(60);
  });

  it("on a 30 Hz display every frame is due", () => {
    expect(simulate(30, true).steps).toBe(60);
  });
});