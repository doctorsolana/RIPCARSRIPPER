import * as THREE from 'three';
import type { Edge, Surface, TrackFrame, TrackTag } from '../types';

// The toy kit every course is built from: the plastic channel's and the roads' numbers, and the small pieces the
// builder, the meshes and the courses share (the frame record, a style along s, the hard limit, a seeded RNG). Units:
// the car is 4 u long. The meadow is y = 0 and ground-level surfaces sit at y = 0.3. Plan view: +x east, +z south.
// Positive yaw turns right (toward +z when heading +x), and right = cross(t, up).

export const KIT = {
  width: 8, rail: 0.8, lip: 0.25, base: 0.25, // plastic channel: floor width, rail height, rail thickness, floor thickness
  floorY: 0.3, // ground-level surfaces sit 0.3 above the meadow (y = 0)
  road: 12, dirt: 11, // road widths
  tabEvery: 17, // blue connectors on the plastic (and the audio's joint ticks) every 17 u of s
  color: '#ff6b00',
} as const;

export const DEG = Math.PI / 180;
export const smooth = (u: number) => u * u * (3 - 2 * u);

/** A tagged range along s; d0..d1: a narrow booster pad's lateral extent; lane: one lane's alone (a split's); floor: a
 *  big jump's gap with roads under its flight - how far under its line a car is lost (arcade.ts). */
export interface Span { tag: TrackTag; s0: number; s1: number; d0?: number; d1?: number; lane?: -1 | 1; floor?: number }
/** What a stretch is made of and how wide (style keys along s; tracks/path.ts). */
export interface Style { surface: Surface; edge: Edge; width: number; shoulder: number }
export interface Key extends Style { s: number }
export interface Range<T> { kind: T; s0: number; s1: number }
export type FrameAt = (s: number, o?: TrackFrame) => TrackFrame;

export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const W = KIT.width / 2, RAIL = KIT.rail, BASE = KIT.base, OUT = W + KIT.lip, LIP = KIT.lip;
export const col = (hex: string) => new THREE.Color(hex);

export const newFrame = (): TrackFrame => ({
  s: 0, p: v3(), t: v3(), up: v3(), right: v3(), kappa: 0, kappaN: 0, width: KIT.width, surface: 'plastic', edge: 'rail', shoulder: 0,
});

/** The hard limit: how far from the centre line the wall the car feels stands - the rails or the barrier at the
 *  surface's edge, or the far side of a grass verge. */
export const hardOf = (f: Style) => f.width / 2 + (f.edge === 'grass' ? f.shoulder : 0);
/** Width of the flat strip just past the hard limit that the tyre stacks or hay bales stand on (u). */
export const STRIP = { rail: 0, barrier: 1.8, grass: 1.2 } as const;

/** Seeded RNG (mulberry32) so the textures and the props are the same on every load. */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
