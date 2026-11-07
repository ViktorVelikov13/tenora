import type { Connection } from "../connection";
import type { ModelClass } from "./types";

/**
 * Finds the connection a model's declared name stands for (`static connection = "tenant"`). Tenancy registers one that
 * knows the current tenant; a resolver returns undefined for a name it does not know, and never falls back to another
 * database.
 */
export type ConnectionResolver = (name: string, model: ModelClass) => Connection | undefined;

let resolver: ConnectionResolver | undefined;

/** Registers how models find their connection by name; undefined removes it. */
export const setConnectionResolver = (next: ConnectionResolver | undefined): void => {
  resolver = next;
};

/** @internal */
export const resolveConnection = (model: ModelClass): Connection => {
  const name = model.connection;
  if (!resolver) {
    throw new Error(
      `Tenora: ${model.name} has no connection. Pass one with ${model.name}.on(db), or register a resolver with setConnectionResolver((name) => …) for its connection "${name}".`
    );
  }
  const connection = resolver(name, model);
  if (!connection) {
    throw new Error(`Tenora: no connection named "${name}" for ${model.name}; the connection resolver returned none.`);
  }
  return connection;
};
