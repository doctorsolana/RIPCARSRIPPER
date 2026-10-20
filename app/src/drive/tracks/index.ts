import type { Track } from '../types';
import { buildTrack as build } from './build.ts';
import type { Course } from './course.ts';
import { framesOf } from './frames.ts';
import { meadow } from './meadow.ts';
import { sky } from './sky.ts';
import { touge } from './touge.ts';

// The courses (?track=<id>), one file each in this folder: the meadow lap, track 2 - the Sky Tower - and track 3, the
// Touge (the drift course). The page's track switch, the results card's "Try <the next one>", the bests' keys and the
// medals all read this list. To add a course: write tracks/<id>.ts exporting a Course (course.ts; meadow.ts, sky.ts and
// touge.ts are the examples) and add it below.
// The rest of the folder is the shared builder: path.ts (the pieces a layout is written in), frames.ts (closure,
// clearance, the frame table), build.ts (the meshes and the queries) with kit.ts, geo.ts, channel.ts, road.ts,
// supports.ts and props.ts.

export const COURSES = [meadow, sky, touge] as const satisfies readonly Course[];
export type CourseId = (typeof COURSES)[number]['id'];
/** The course with no ?track= (and the bests' unprefixed key, from before track 2): the meadow. */
export const DEFAULT_COURSE: CourseId = 'meadow';
export const isCourse = (id: string | null | undefined): id is CourseId => COURSES.some((c) => c.id === id);
export const courseOf = (id: CourseId): Course<CourseId> => COURSES.find((c) => c.id === id)!;

export type { Course } from './course.ts';

/** Builds a course's track (tracks/build.ts). `nearest()` returns a shared object (valid until the next call) whose
 *  `offset` is LOCAL to the frame: x along t, y along up (height above the surface), z along right (lateral, + right). */
export function buildTrack(course: CourseId = DEFAULT_COURSE): Track {
  return build(courseOf(course));
}

/** A course's closed centre line and frame table, no meshes (tracks/frames.ts). */
export function buildFrames(course: CourseId = DEFAULT_COURSE) {
  return framesOf(courseOf(course));
}
