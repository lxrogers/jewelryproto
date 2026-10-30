/**
 * Coin Mesh Generator - Triangulation Helpers
 * Uses earcut for polygon triangulation with support for internal vertices
 */

import earcut from 'earcut';

/**
 * Triangulates a polygon defined by outline points
 * @param outlinePoints - Array of [x, y] points defining the polygon boundary
 * @returns Array of triangle indices
 */
export function triangulatePolygon(outlinePoints: [number, number][]): number[] {
  // Flatten the points array for earcut
  const flatPoints: number[] = [];
  for (const [x, y] of outlinePoints) {
    flatPoints.push(x, y);
  }

  // earcut returns indices into the flattened array
  return earcut(flatPoints);
}

/**
 * Generates a triangulated disc with internal vertices for better displacement mapping
 * Returns positions, indices, and UVs for the disc
 *
 * @param outlinePoints - Array of [x, y] points defining the boundary
 * @param center - Center point [x, y] of the disc
 * @param radialSegments - Number of radial rings of vertices inside the disc
 */
export function triangulateDiscWithInternalVertices(
  outlinePoints: [number, number][],
  center: [number, number],
  radialSegments: number
): {
  positions: [number, number][];
  indices: number[];
  uvs: [number, number][];
  boundaryStartIndex: number;
} {
  const positions: [number, number][] = [];
  const uvs: [number, number][] = [];
  const indices: number[] = [];

  const n = outlinePoints.length;
  const [cx, cy] = center;

  // Find the bounding box for UV normalization
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const [x, y] of outlinePoints) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  // Helper to compute UV from position
  const posToUV = (x: number, y: number): [number, number] => {
    return [(x - minX) / rangeX, (y - minY) / rangeY];
  };

  // Add center vertex first
  positions.push([cx, cy]);
  uvs.push(posToUV(cx, cy));
  const centerIndex = 0;

  // Add internal rings of vertices (from center outward)
  const ringStartIndices: number[] = [0]; // Center is "ring 0"

  for (let ring = 1; ring <= radialSegments; ring++) {
    const t = ring / (radialSegments + 1); // 0 < t < 1, approaching but not reaching boundary
    ringStartIndices.push(positions.length);

    for (let i = 0; i < n; i++) {
      const [ox, oy] = outlinePoints[i];
      // Interpolate between center and outline point
      const x = cx + (ox - cx) * t;
      const y = cy + (oy - cy) * t;
      positions.push([x, y]);
      uvs.push(posToUV(x, y));
    }
  }

  // Add boundary vertices (the actual outline)
  const boundaryStartIndex = positions.length;
  ringStartIndices.push(boundaryStartIndex);
  for (const [x, y] of outlinePoints) {
    positions.push([x, y]);
    uvs.push(posToUV(x, y));
  }

  // Triangulate: connect center to first ring
  // Winding order: CCW when viewed from +Y (after Y/Z swap in generator)
  // Since outline goes CCW, we need (center, i2, i1) to get CCW winding
  if (radialSegments >= 1) {
    // Center to first ring
    const firstRingStart = ringStartIndices[1];
    for (let i = 0; i < n; i++) {
      const i1 = firstRingStart + i;
      const i2 = firstRingStart + ((i + 1) % n);
      indices.push(centerIndex, i2, i1);  // Reversed for CCW
    }

    // Connect consecutive rings
    for (let ring = 1; ring < radialSegments + 1; ring++) {
      const innerStart = ringStartIndices[ring];
      const outerStart = ringStartIndices[ring + 1];

      for (let i = 0; i < n; i++) {
        const nextI = (i + 1) % n;

        const innerCurr = innerStart + i;
        const innerNext = innerStart + nextI;
        const outerCurr = outerStart + i;
        const outerNext = outerStart + nextI;

        // Two triangles per quad - CCW winding
        indices.push(innerCurr, outerNext, outerCurr);
        indices.push(innerCurr, innerNext, outerNext);
      }
    }
  } else {
    // No internal rings, just triangulate from center
    for (let i = 0; i < n; i++) {
      const i1 = boundaryStartIndex + i;
      const i2 = boundaryStartIndex + ((i + 1) % n);
      indices.push(centerIndex, i2, i1);  // Reversed for CCW
    }
  }

  return { positions, indices, uvs, boundaryStartIndex };
}

/**
 * Simple disc triangulation as a fan from center (no internal vertices)
 */
export function triangulateDiscSimple(
  outlinePoints: [number, number][],
  center: [number, number]
): {
  positions: [number, number][];
  indices: number[];
} {
  const positions: [number, number][] = [];
  const indices: number[] = [];

  const n = outlinePoints.length;
  const [cx, cy] = center;

  // Center vertex
  positions.push([cx, cy]);

  // Outline vertices
  for (const [x, y] of outlinePoints) {
    positions.push([x, y]);
  }

  // Fan triangles
  for (let i = 0; i < n; i++) {
    const i1 = 1 + i;
    const i2 = 1 + ((i + 1) % n);
    indices.push(0, i1, i2);
  }

  return { positions, indices };
}
