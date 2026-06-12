type Observer<T> = { next: (v: T) => void; error?: (e: unknown) => void; complete?: () => void };
type Teardown = () => void;
type Producer<T> = (observer: Observer<T>) => Teardown;

export class Subscription {
  constructor(private teardown: Teardown) {}
  unsubscribe(): void {
    // BUG: teardown is never called
  }
}

export class Observable<T> {
  constructor(private producer: Producer<T>) {}

  subscribe(observer: Observer<T>): Subscription {
    const teardown = this.producer(observer);
    return new Subscription(teardown);
  }
}
