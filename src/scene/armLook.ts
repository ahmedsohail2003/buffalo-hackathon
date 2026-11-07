// How the SO-101 looks in the bay: the model's printed parts in station white, its servos and
// fasteners near-black. Used as the core's mesh factory (one mesh per visual geom).
import * as THREE from 'three';
import type { MeshFactory } from '../core';

const shell = new THREE.MeshStandardMaterial({ color: '#e9edf2', roughness: 0.42, metalness: 0.06, flatShading: true });
const dark = new THREE.MeshStandardMaterial({ color: '#1a1d23', roughness: 0.5, metalness: 0.28, flatShading: true });

/** White for the light parts of the model (its printed shell), near-black for the dark ones. */
export const stationArmMeshFactory: MeshFactory = ({ geom, geometry }) => {
  const [r, g, b] = geom.rgba;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mesh = new THREE.Mesh(geometry, luminance < 0.3 ? dark : shell);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};
