import { classChain } from "./events";
import type { Model } from "./model";
import type { ModelQuery } from "./query";

/** A scope: a function from a query to the query with more conditions, which it returns. */
export type Scope<M extends Model = any, A extends unknown[] = []> = (query: ModelQuery<M>, ...args: A) => ModelQuery<M>;

/**
 * A local scope, applied with `query.apply(User.active)`, or `query.apply(User.ofRole, "admin")` when it takes
 * arguments. Inside a class body the query's type cannot come from the class, so name it to check the columns:
 * `scope<User>((query) => query.where("active", true))`.
 */
export const scope = <M extends Model = any, A extends unknown[] = []>(fn: Scope<M, A>): Scope<M, A> => {
  if (typeof fn !== "function") throw new Error("Tenora: scope() needs a function (query) => query.");
  return fn;
};

const registered = new WeakMap<Function, Map<string, Scope>>();

export const addGlobalScope = (model: Function, name: string, fn: Scope) => {
  if (typeof fn !== "function") throw new Error(`Tenora: the global scope "${name}" must be a function (query) => query.`);
  let scopes = registered.get(model);
  if (!scopes) registered.set(model, (scopes = new Map()));
  scopes.set(name, fn);
};

/** The global scopes of a model: the ones added with addGlobalScope (its own and its parents'), then `static globalScopes`. */
export const globalScopesOf = (model: Function, declared: Readonly<Record<string, Scope>>): Map<string, Scope> => {
  const scopes = new Map<string, Scope>();
  for (const current of classChain(model)) {
    for (const [name, fn] of registered.get(current) ?? []) scopes.set(name, fn);
  }
  for (const [name, fn] of Object.entries(declared ?? {})) scopes.set(name, fn);
  return scopes;
};
