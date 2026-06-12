export class Scheduler {
  constructor(private concurrency: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    throw new Error("not implemented");
  }
}
