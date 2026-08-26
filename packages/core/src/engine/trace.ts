import type { DayRecorder } from "./attempt.js";

/**
 * Accumulates one path's day-by-day equity and effective max-loss floor.
 * Pure observation: recording never touches the RNG or the numbers.
 */
export class TraceRecorder implements DayRecorder {
  readonly equity: number[] = [];
  readonly floor: number[] = [];
  readonly stepBoundaries: number[] = [];

  day(balance: number, maxFloor: number): void {
    this.equity.push(balance);
    this.floor.push(maxFloor);
  }

  stepEnd(): void {
    this.stepBoundaries.push(this.equity.length);
  }
}
