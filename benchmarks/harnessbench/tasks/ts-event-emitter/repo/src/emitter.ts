type Listener<T = unknown> = (data: T) => void;

export class EventEmitter<Events extends Record<string, unknown> = Record<string, unknown>> {
  private listeners = new Map<string, Listener[]>();

  on<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as Listener);
    this.listeners.set(event, list);
    return this;
  }

  emit<K extends keyof Events & string>(event: K, data: Events[K]): boolean {
    const list = this.listeners.get(event);
    if (!list?.length) return false;
    list.forEach((fn) => fn(data));
    return true;
  }
}
