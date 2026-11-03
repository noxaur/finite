import type { Gesture } from "../gesture";
import { moveArtboard } from "./artboard";
import { selectBox } from "./marquee";
import { moveElement } from "./move";
import { resizeNode } from "./resize";

/** Every gesture, in the order they're offered a press: the first to take it runs. */
export const GESTURES: ReadonlyArray<Gesture> = [resizeNode, moveArtboard, moveElement, selectBox];
