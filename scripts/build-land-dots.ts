// Generates public/land-dots.json: a latitude-scaled dot grid covering land, for the homepage globe.
// Land outlines come from world-atlas (Natural Earth 1:110m). Run with: npm run build:land
import { readFileSync, writeFileSync } from "node:fs";
import { geoContains } from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

const SPACING_DEG = 3;

const topology = JSON.parse(
  readFileSync(new URL("../node_modules/world-atlas/land-110m.json", import.meta.url), "utf8"),
) as Topology<{ land: GeometryCollection }>;
const land = feature(topology, topology.objects.land);

const dots: number[] = [];
for (let lat = -87; lat <= 87; lat += SPACING_DEG) {
  // Fewer dots per ring toward the poles so the spacing on the ground stays even.
  const n = Math.max(1, Math.round(360 / (SPACING_DEG / Math.cos((lat * Math.PI) / 180))));
  for (let i = 0; i < n; i++) {
    const lon = -180 + ((i + 0.5) * 360) / n;
    if (geoContains(land, [lon, lat])) dots.push(Math.round(lon * 10) / 10, Math.round(lat * 10) / 10);
  }
}

writeFileSync(
  new URL("../public/land-dots.json", import.meta.url),
  JSON.stringify({ spacing: SPACING_DEG, dots }),
);
console.log(`Wrote ${dots.length / 2} land dots to public/land-dots.json`);
