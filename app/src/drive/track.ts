// The tracks live in tracks/ (one file per course, and the shared builder: tracks/index.ts). This file only keeps the
// old import path working for scripts that load it by path (node test harnesses: buildTrack, buildFrames and the
// courses' constants); the app imports tracks/ directly.
export { COURSES, DEFAULT_COURSE, buildFrames, buildTrack, courseOf, isCourse, type Course, type CourseId } from './tracks/index.ts';
export { KIT, rng } from './tracks/kit.ts';
export { BIG, JUMP, MEADOW, MEADOW as TRACK_SPEC } from './tracks/meadow.ts';
export { CLIMB, DOUBLE, SKY, SKYJ, SKY_BUMPS } from './tracks/sky.ts';
export type { Stack } from './tracks/supports.ts';
