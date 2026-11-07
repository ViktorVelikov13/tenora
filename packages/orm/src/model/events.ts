import type { Connection } from "../connection";

export const MODEL_EVENTS = [
  "retrieved",
  "creating",
  "created",
  "updating",
  "updated",
  "saving",
  "saved",
  "deleting",
  "deleted",
  "restoring",
  "restored",
  "forceDeleting",
  "forceDeleted",
] as const;

export type ModelEvent = (typeof MODEL_EVENTS)[number];

/** The events that run before a write and cancel it by returning false. */
const BEFORE = new Set<ModelEvent>(["creating", "updating", "saving", "deleting", "restoring", "forceDeleting"]);

export type EventListener<M> = (model: M) => unknown;

export type ListenerOptions = {
  /**
   * Run after the surrounding transaction commits, and not at all if it rolls back; straight away when none is open.
   * Only for the events after a write: the ones before it still run first, since they can change or cancel it.
   */
  afterCommit?: boolean;
};

/** An object (or a class of them) with a method per event: `{ created(user) { … }, deleted(user) { … } }`. */
export type Observer<M> = { [E in ModelEvent]?: EventListener<M> } & ListenerOptions;
export type ObserverClass<M> = (new () => Observer<M>) & ListenerOptions;

type Listener = { handler: EventListener<any>; afterCommit: boolean };

/** Each model class's own listeners. A model also hears the listeners of the classes it extends. */
const registry = new WeakMap<Function, Map<ModelEvent, Listener[]>>();

/** A class and the model classes it extends, base first. */
export const classChain = (model: Function): Function[] => {
  const chain: Function[] = [];
  for (let current = model; current && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
    chain.unshift(current);
  }
  return chain;
};

export const listen = (model: Function, event: ModelEvent, handler: EventListener<any>, options: ListenerOptions = {}) => {
  if (typeof handler !== "function") throw new Error(`Tenora: a "${event}" listener must be a function.`);
  let events = registry.get(model);
  if (!events) registry.set(model, (events = new Map()));
  const listeners = events.get(event) ?? [];
  events.set(event, [...listeners, { handler, afterCommit: options.afterCommit === true }]);
};

export const observe = (model: Function, observer: Observer<any> | ObserverClass<any>) => {
  const instance = (typeof observer === "function" ? new observer() : observer) as Record<string, unknown>;
  const afterCommit = Boolean(instance.afterCommit ?? (typeof observer === "function" ? observer.afterCommit : false));
  let found = false;
  for (const event of MODEL_EVENTS) {
    const method = instance[event];
    if (typeof method !== "function") continue;
    found = true;
    listen(model, event, (target) => method.call(instance, target), { afterCommit });
  }
  if (!found) throw new Error(`Tenora: that observer has no method for any model event (${MODEL_EVENTS.join(", ")}).`);
};

export const forget = (model: Function) => registry.delete(model);

const listenersFor = (model: Function, event: ModelEvent): Listener[] =>
  classChain(model).flatMap((current) => registry.get(current)?.get(event) ?? []);

export const hasListeners = (model: Function, event: ModelEvent): boolean => listenersFor(model, event).length > 0;

/**
 * Runs the listeners of an event in order, each awaited, in the caller's async context, so their queries join the
 * transaction the write runs in. Returns false when a listener of a "before" event returned false.
 */
export const fire = async (model: object, event: ModelEvent, connection: Connection): Promise<boolean> => {
  const listeners = listenersFor(model.constructor, event);
  for (const { handler, afterCommit } of listeners) {
    if (afterCommit && !BEFORE.has(event)) {
      await connection.afterCommit(() => handler(model));
      continue;
    }
    const result = await handler(model);
    if (result === false && BEFORE.has(event)) return false;
  }
  return true;
};
