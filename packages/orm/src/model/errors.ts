/** `findOrFail()`, `firstOrFail()` or `refresh()` found no row. */
export class ModelNotFoundError extends Error {
  override readonly name = "ModelNotFoundError";

  constructor(
    /** the model's class name */
    readonly model: string,
    /** the keys that were looked for, if any */
    readonly ids: readonly unknown[] = []
  ) {
    super(
      ids.length
        ? `Tenora: no ${model} with key ${ids.map((id) => JSON.stringify(id)).join(", ")}.`
        : `Tenora: no ${model} matches the query.`
    );
  }
}

/** `fill()` got a key that `fillable` and `guarded` do not allow. */
export class MassAssignmentError extends Error {
  override readonly name = "MassAssignmentError";
}

/** A relation was read before it was loaded. */
export class RelationNotLoadedError extends Error {
  override readonly name = "RelationNotLoadedError";
}
