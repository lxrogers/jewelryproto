/**
 * Coin Mesh Generator - Core Generator Class
 * Generates Three.js BufferGeometry for coins with rounded edges
 */

import * as THREE from 'three';
import { CoinMeshParams, DeformationParams, OutlineFunction, OutlinePoint } from './types';

/**
 * Simplex 2D noise - attempt at a simple implementation
 * Based on Stefan Gustavson's implementation
 */
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// Permutation table
const perm = new Uint8Array(512);
const grad2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

// Initialize permutation table
for (let i = 0; i < 256; i++) {
  perm[i] = i;
}
// Shuffle
for (let i = 255; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [perm[i], perm[j]] = [perm[j], perm[i]];
}
// Duplicate for overflow
for (let i = 0; i < 256; i++) {
  perm[i + 256] = perm[i];
}

function dot2(g: number[], x: number, y: number): number {
  return g[0] * x + g[1] * y;
}

/**
 * 2D Simplex noise
 */
function simplex2D(x: number, y: number): number {
  // Skew input space
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);

  const t = (i + j) * G2;
  const X0 = i - t;
  const Y0 = j - t;
  const x0 = x - X0;
  const y0 = y - Y0;

  // Determine simplex
  let i1: number, j1: number;
  if (x0 > y0) {
    i1 = 1; j1 = 0;
  } else {
    i1 = 0; j1 = 1;
  }

  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;

  // Hash coordinates
  const ii = i & 255;
  const jj = j & 255;
  const gi0 = perm[ii + perm[jj]] % 8;
  const gi1 = perm[ii + i1 + perm[jj + j1]] % 8;
  const gi2 = perm[ii + 1 + perm[jj + 1]] % 8;

  // Calculate contributions
  let n0 = 0, n1 = 0, n2 = 0;

  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 >= 0) {
    t0 *= t0;
    n0 = t0 * t0 * dot2(grad2[gi0], x0, y0);
  }

  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 >= 0) {
    t1 *= t1;
    n1 = t1 * t1 * dot2(grad2[gi1], x1, y1);
  }

  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 >= 0) {
    t2 *= t2;
    n2 = t2 * t2 * dot2(grad2[gi2], x2, y2);
  }

  // Scale to [-1, 1]
  return 70 * (n0 + n1 + n2);
}

/**
 * Fractal Brownian Motion using simplex noise
 */
function fbm2D(x: number, y: number, octaves: number, persistence: number): number {
  let total = 0;
  let frequency = 1;
  let amplitude = 1;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    total += simplex2D(x * frequency, y * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= 2;
  }

  return total / maxValue;
}

/**
 * Main generator class for coin meshes
 *
 * Geometry layout:
 * - Coin lies flat in XZ plane, Y is up
 * - Top face at Y = +halfThickness
 * - Bottom face at Y = -halfThickness
 * - Rim connects top and bottom with rounded fillet
 */
export class CoinMeshGenerator {
  private params: CoinMeshParams;
  private outlinePoints: OutlinePoint[] = [];

  constructor(params: CoinMeshParams) {
    this.params = {
      uvMode: 'planar',
      faceRadialSegments: 8,
      ...params,
    };
    this.sampleOutline();
  }

  private sampleOutline(): void {
    const { outline, outlineSamples } = this.params;
    this.outlinePoints = [];
    for (let i = 0; i < outlineSamples; i++) {
      const t = i / outlineSamples;
      this.outlinePoints.push(outline(t));
    }
  }

  /**
   * Compute Y deformation at a given XZ position
   */
  private getYDeformation(x: number, z: number): number {
    const def = this.params.deformation;
    if (!def || !def.enabled) return 0;

    const nx = x * def.frequencyX + def.phaseX;
    const nz = z * def.frequencyZ + def.phaseZ;

    const noise = fbm2D(nx, nz, def.octaves, def.persistence);
    return noise * def.amplitude;
  }

  generateGeometry(): THREE.BufferGeometry {
    const startTime = performance.now();

    const { outlineSamples, profileSegments, thickness, edgeRadius, faceRadialSegments = 8 } = this.params;
    const halfThickness = thickness / 2;
    const r = Math.min(edgeRadius, halfThickness); // Clamp radius

    // Profile: semicircle from top to bottom
    // profileSegments points along the rounded edge
    const profilePoints = profileSegments + 1;

    // Face vertices with concentric rings:
    // - 1 center vertex
    // - faceRadialSegments rings, each with outlineSamples vertices
    // - 1 boundary ring (outlineSamples vertices) that matches rim edge
    const faceRings = faceRadialSegments + 1; // internal rings + boundary
    const faceVertexCount = 1 + faceRings * outlineSamples; // center + all rings

    // Total vertices
    // Rim: outlineSamples * profilePoints
    // Top face: faceVertexCount
    // Bottom face: faceVertexCount
    const rimVertexCount = outlineSamples * profilePoints;
    const totalVertices = rimVertexCount + faceVertexCount * 2;

    // Face indices with concentric rings:
    // - Center to first ring: outlineSamples triangles
    // - Between rings: faceRadialSegments * outlineSamples * 2 triangles (quads)
    const faceCenterTriangles = outlineSamples;
    const faceRingTriangles = faceRings * outlineSamples * 2; // quads between rings
    const faceTriangleCount = faceCenterTriangles + faceRingTriangles;

    // Indices
    // Rim: outlineSamples * profileSegments * 6
    // Top face: faceTriangleCount * 3
    // Bottom face: faceTriangleCount * 3
    const rimIndexCount = outlineSamples * profileSegments * 6;
    const faceIndexCount = faceTriangleCount * 3;
    const totalIndices = rimIndexCount + faceIndexCount * 2;

    const positions = new Float32Array(totalVertices * 3);
    const normals = new Float32Array(totalVertices * 3);
    const uvs = new Float32Array(totalVertices * 2);
    const indices = new Uint32Array(totalIndices);

    let vi = 0; // vertex index
    let ii = 0; // index index

    // ========== RIM VERTICES ==========
    // Profile sweeps from top (angle=0) around to bottom (angle=PI)
    // At each outline point, generate profilePoints vertices
    const rimStart = vi;

    for (let i = 0; i < outlineSamples; i++) {
      const { position, normal } = this.outlinePoints[i];
      const [ox, oz] = position; // outline x,y -> world x,z
      const [nx, nz] = normal;   // outward normal in XZ plane

      for (let j = 0; j < profilePoints; j++) {
        const t = j / profileSegments;
        const angle = t * Math.PI; // 0 to PI

        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        // Position: offset outward by r*sinA, height is based on cosA
        // At angle=0: sinA=0, cosA=1 -> at outline, Y = halfThickness - r + r = halfThickness
        // At angle=PI/2: sinA=1, cosA=0 -> offset outward by r, Y = halfThickness - r
        // At angle=PI: sinA=0, cosA=-1 -> at outline, Y = halfThickness - r - r = -halfThickness + 2r - r...

        // Let me recalculate:
        // The fillet center is at (ox, halfThickness - r, oz) for top half
        // and at (ox, -(halfThickness - r), oz) for bottom half
        //
        // Actually, for a semicircular profile, the center line is at Y=0
        // and the profile goes from Y = halfThickness (top) to Y = -halfThickness (bottom)
        // with the outer extent at Y = 0 offset outward by r

        // Simpler model:
        // - At angle=0 (top): Y = halfThickness, no outward offset
        // - At angle=PI/2 (middle): Y = 0, outward offset = r
        // - At angle=PI (bottom): Y = -halfThickness, no outward offset

        // For this, use:
        // Y = halfThickness * cos(angle)  [goes from +h to -h]
        // outward = r * sin(angle)         [0 at top/bottom, r at middle]

        // But wait, that's not a fillet - that's a lens shape.
        // A fillet should have flat top/bottom faces.

        // For a proper coin with filleted edges:
        // - Flat top at Y = halfThickness, from center to (outline - r offset inward)
        // - Fillet from (outline, halfThickness - r) curving to (outline + r, halfThickness - r)
        //   No wait, that's also wrong.

        // Let's think of it as a torus section:
        // The fillet is a quarter-circle that rounds the edge.
        // - Inner edge of fillet: at outline, Y = halfThickness - r (top) or Y = -(halfThickness - r) (bottom)
        // - Outer edge of fillet: at outline + r*normal, Y = halfThickness (top) or -halfThickness (bottom)

        // So the profile from top to bottom:
        // 1. Top fillet: quarter circle from (outline, halfThickness) to (outline+r, halfThickness-r)
        // 2. Straight middle: from (outline+r, halfThickness-r) to (outline+r, -(halfThickness-r))
        // 3. Bottom fillet: quarter circle from (outline+r, -(halfThickness-r)) to (outline, -halfThickness)

        // Let's simplify and just do this:
        // The entire rim is a semicircle profile where:
        // - The semicircle center is at the outline position
        // - Radius of semicircle is min(edgeRadius, halfThickness)
        // - At angle=0: top of coin (Y = r, outward = 0)
        // - At angle=PI: bottom of coin (Y = -r, outward = 0)
        // - At angle=PI/2: maximum outward extent (Y = 0, outward = r)

        // This gives a "lens" shape which is fine for now.
        // For thickness > 2*r, we'd need a straight middle section.

        const baseY = r * cosA;
        const outward = r * sinA;

        const x = ox + nx * outward;
        const z = oz + nz * outward;

        // Apply Y deformation
        const yDeform = this.getYDeformation(x, z);
        const y = baseY + yDeform;

        positions[vi * 3] = x;
        positions[vi * 3 + 1] = y;
        positions[vi * 3 + 2] = z;

        // Normal points outward from the profile center
        const normX = nx * sinA;
        const normY = cosA;
        const normZ = nz * sinA;

        // Normalize
        const len = Math.sqrt(normX * normX + normY * normY + normZ * normZ);
        normals[vi * 3] = normX / len;
        normals[vi * 3 + 1] = normY / len;
        normals[vi * 3 + 2] = normZ / len;

        uvs[vi * 2] = i / outlineSamples;
        uvs[vi * 2 + 1] = t;

        vi++;
      }
    }

    // ========== TOP FACE VERTICES (with concentric rings) ==========
    const topFaceStart = vi;
    const centerX = 0, centerZ = 0;

    // Center vertex
    const centerYDeform = this.getYDeformation(centerX, centerZ);
    positions[vi * 3] = centerX;
    positions[vi * 3 + 1] = r + centerYDeform;
    positions[vi * 3 + 2] = centerZ;
    normals[vi * 3] = 0;
    normals[vi * 3 + 1] = 1;
    normals[vi * 3 + 2] = 0;
    uvs[vi * 2] = 0.5;
    uvs[vi * 2 + 1] = 0.5;
    vi++;

    // Concentric rings from center outward
    // Ring 0 is closest to center, ring faceRings-1 is the boundary
    for (let ring = 0; ring < faceRings; ring++) {
      // t goes from close to 0 (near center) to 1 (at boundary)
      const t = (ring + 1) / faceRings;

      for (let i = 0; i < outlineSamples; i++) {
        const { position } = this.outlinePoints[i];
        const [ox, oz] = position;

        // Interpolate from center to outline
        const x = centerX + (ox - centerX) * t;
        const z = centerZ + (oz - centerZ) * t;

        const yDeform = this.getYDeformation(x, z);
        positions[vi * 3] = x;
        positions[vi * 3 + 1] = r + yDeform;
        positions[vi * 3 + 2] = z;
        normals[vi * 3] = 0;
        normals[vi * 3 + 1] = 1;
        normals[vi * 3 + 2] = 0;

        uvs[vi * 2] = (x / 20) + 0.5;
        uvs[vi * 2 + 1] = (z / 20) + 0.5;
        vi++;
      }
    }

    // ========== BOTTOM FACE VERTICES (with concentric rings) ==========
    const bottomFaceStart = vi;

    // Center vertex
    positions[vi * 3] = centerX;
    positions[vi * 3 + 1] = -r + centerYDeform;
    positions[vi * 3 + 2] = centerZ;
    normals[vi * 3] = 0;
    normals[vi * 3 + 1] = -1;
    normals[vi * 3 + 2] = 0;
    uvs[vi * 2] = 0.5;
    uvs[vi * 2 + 1] = 0.5;
    vi++;

    // Concentric rings from center outward
    for (let ring = 0; ring < faceRings; ring++) {
      const t = (ring + 1) / faceRings;

      for (let i = 0; i < outlineSamples; i++) {
        const { position } = this.outlinePoints[i];
        const [ox, oz] = position;

        const x = centerX + (ox - centerX) * t;
        const z = centerZ + (oz - centerZ) * t;

        const yDeform = this.getYDeformation(x, z);
        positions[vi * 3] = x;
        positions[vi * 3 + 1] = -r + yDeform;
        positions[vi * 3 + 2] = z;
        normals[vi * 3] = 0;
        normals[vi * 3 + 1] = -1;
        normals[vi * 3 + 2] = 0;

        uvs[vi * 2] = (x / 20) + 0.5;
        uvs[vi * 2 + 1] = (z / 20) + 0.5;
        vi++;
      }
    }

    // ========== RIM INDICES ==========
    for (let i = 0; i < outlineSamples; i++) {
      const iNext = (i + 1) % outlineSamples;

      for (let j = 0; j < profileSegments; j++) {
        const v00 = rimStart + i * profilePoints + j;
        const v10 = rimStart + iNext * profilePoints + j;
        const v01 = rimStart + i * profilePoints + (j + 1);
        const v11 = rimStart + iNext * profilePoints + (j + 1);

        // Two triangles per quad, CCW winding for outward-facing
        indices[ii++] = v00;
        indices[ii++] = v10;
        indices[ii++] = v11;

        indices[ii++] = v00;
        indices[ii++] = v11;
        indices[ii++] = v01;
      }
    }

    // ========== TOP FACE INDICES (with concentric rings) ==========
    const topCenter = topFaceStart;
    const topFirstRing = topFaceStart + 1;

    // Center to first ring (triangles)
    for (let i = 0; i < outlineSamples; i++) {
      const iNext = (i + 1) % outlineSamples;
      // CCW when viewed from above (+Y)
      indices[ii++] = topCenter;
      indices[ii++] = topFirstRing + iNext;
      indices[ii++] = topFirstRing + i;
    }

    // Between rings (quads as 2 triangles each)
    for (let ring = 0; ring < faceRings - 1; ring++) {
      const innerRingStart = topFaceStart + 1 + ring * outlineSamples;
      const outerRingStart = topFaceStart + 1 + (ring + 1) * outlineSamples;

      for (let i = 0; i < outlineSamples; i++) {
        const iNext = (i + 1) % outlineSamples;

        const inner0 = innerRingStart + i;
        const inner1 = innerRingStart + iNext;
        const outer0 = outerRingStart + i;
        const outer1 = outerRingStart + iNext;

        // CCW when viewed from above
        indices[ii++] = inner0;
        indices[ii++] = outer1;
        indices[ii++] = outer0;

        indices[ii++] = inner0;
        indices[ii++] = inner1;
        indices[ii++] = outer1;
      }
    }

    // ========== BOTTOM FACE INDICES (with concentric rings) ==========
    const bottomCenter = bottomFaceStart;
    const bottomFirstRing = bottomFaceStart + 1;

    // Center to first ring (triangles)
    for (let i = 0; i < outlineSamples; i++) {
      const iNext = (i + 1) % outlineSamples;
      // CCW when viewed from below (-Y)
      indices[ii++] = bottomCenter;
      indices[ii++] = bottomFirstRing + i;
      indices[ii++] = bottomFirstRing + iNext;
    }

    // Between rings (quads as 2 triangles each)
    for (let ring = 0; ring < faceRings - 1; ring++) {
      const innerRingStart = bottomFaceStart + 1 + ring * outlineSamples;
      const outerRingStart = bottomFaceStart + 1 + (ring + 1) * outlineSamples;

      for (let i = 0; i < outlineSamples; i++) {
        const iNext = (i + 1) % outlineSamples;

        const inner0 = innerRingStart + i;
        const inner1 = innerRingStart + iNext;
        const outer0 = outerRingStart + i;
        const outer1 = outerRingStart + iNext;

        // CCW when viewed from below (reversed winding)
        indices[ii++] = inner0;
        indices[ii++] = outer0;
        indices[ii++] = outer1;

        indices[ii++] = inner0;
        indices[ii++] = outer1;
        indices[ii++] = inner1;
      }
    }

    // Create geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // Recompute normals if deformation is enabled (analytical normals won't be correct)
    if (this.params.deformation?.enabled) {
      geometry.computeVertexNormals();
    }

    const elapsed = performance.now() - startTime;
    console.log(`CoinMesh generated in ${elapsed.toFixed(2)}ms - ${vi} vertices, ${ii/3} triangles`);

    return geometry;
  }

  updatePositions(geometry: THREE.BufferGeometry, newThickness: number, newEdgeRadius: number): void {
    // For now, just regenerate
    this.params.thickness = newThickness;
    this.params.edgeRadius = newEdgeRadius;
    const newGeom = this.generateGeometry();

    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const newPos = newGeom.getAttribute('position') as THREE.BufferAttribute;
    posAttr.array.set(newPos.array);
    posAttr.needsUpdate = true;

    const normAttr = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const newNorm = newGeom.getAttribute('normal') as THREE.BufferAttribute;
    normAttr.array.set(newNorm.array);
    normAttr.needsUpdate = true;

    newGeom.dispose();
  }

  getVertexCount(): number {
    const { outlineSamples, profileSegments, faceRadialSegments = 8 } = this.params;
    const profilePoints = profileSegments + 1;
    const faceRings = faceRadialSegments + 1;
    const faceVertexCount = 1 + faceRings * outlineSamples;
    return outlineSamples * profilePoints + faceVertexCount * 2;
  }

  getTriangleCount(): number {
    const { outlineSamples, profileSegments, faceRadialSegments = 8 } = this.params;
    const faceRings = faceRadialSegments + 1;
    // Rim triangles
    const rimTriangles = outlineSamples * profileSegments * 2;
    // Face triangles: center fan + ring quads (each quad = 2 triangles)
    const faceCenterTriangles = outlineSamples;
    const faceRingTriangles = (faceRings - 1) * outlineSamples * 2;
    const faceTriangles = (faceCenterTriangles + faceRingTriangles) * 2; // top + bottom
    return rimTriangles + faceTriangles;
  }
}
