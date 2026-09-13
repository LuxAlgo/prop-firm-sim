import type { DayRecorder } from "./attempt.js";

/**
 * Accumulates one path's day-by-day equity and enforced loss boundaries.
 * Pure observation: recording never touches the RNG or the numbers.
 */
export class TraceRecorder implements DayRecorder {
  readonly equity: number[] = [];
  readonly floor: number[] = [];
  readonly dailyFloor: (number | null)[] = [];
  readonly stepBoundaries: number[] = [];

  day(balance: number, maxFloor: number, dailyFloor: number | null): void {
    this.equity.push(balance);
    this.floor.push(maxFloor);
    this.dailyFloor.push(dailyFloor);
  }

  stepEnd(): void {
    this.stepBoundaries.push(this.equity.length);
  }
}
