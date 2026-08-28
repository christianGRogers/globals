import type { Snapshot } from "./reader.js";

/**
 * Types.
 *
 * Two jobs, and the second one matters more than the first.
 *
 * The first is inference: declare the shape once and get typed reads without casting at
 * every call site.
 *
 * The second is making the contract visible in the types. A synchronous read and an
 * asynchronous write must not look alike, because the entire class of bug this library
 * invites is reading straight after writing and expecting the new value. So a write returns
 * a promise, always, even where an implementation could resolve it immediately.
 */

/** The values the type ladder can encode. Anything else needs the asynchronous tier. */
export type Encodable =
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint
  | Date
  | RegExp
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array
  | Encodable[]
  | { [key: string]: Encodable }
  | Map<string | number | boolean | null, Encodable>
  | Set<string | number | boolean | null>;

/** A state shape this library can hold. */
export type StateShape = { [key: string]: Encodable };

/** Deeply readonly, which is what a snapshot is. */
export type Immutable<T> = T extends (infer Element)[]
  ? readonly Immutable<Element>[]
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<K, Immutable<V>>
    : T extends Set<infer M>
      ? ReadonlySet<M>
      : T extends Date | RegExp | ArrayBufferView
        ? T
        : T extends object
          ? { readonly [K in keyof T]: Immutable<T[K]> }
          : T;

/** Mutable, which is what a draft is. */
export type Draft<T> = T extends (infer Element)[]
  ? Draft<Element>[]
  : T extends Map<infer K, infer V>
    ? Map<K, Draft<V>>
    : T extends Set<infer M>
      ? Set<M>
      : T extends Date | RegExp | ArrayBufferView
        ? T
        : T extends object
          ? { -readonly [K in keyof T]: Draft<T[K]> }
          : T;

/**
 * A typed read side store.
 *
 * Every method here is synchronous, and there is no method that writes. A window holding one
 * of these cannot write by accident, because there is nothing to call.
 */
export interface TypedReadableStore<State extends StateShape> {
  get(): Immutable<State>;
  select<T>(path: readonly (string | number)[]): T | undefined;
  snapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  readonly version: number;
}

/**
 * A typed write side store.
 *
 * `update` and `set` return promises. That is not an implementation detail leaking into the
 * type: it is the contract. A write is serialised by the owner, so the value is not
 * observable on the next line, and a signature that returned a version synchronously would
 * be a lie that costs somebody a day.
 */
export interface TypedWritableStore<State extends StateShape> extends TypedReadableStore<State> {
  update(recipe: (draft: Draft<State>) => void): Promise<number>;
  set(value: State): Promise<number>;
}

/**
 * A named write, as a window sends it.
 *
 * Functions cannot cross a process boundary, so a window sends the name of an operation and
 * a payload. Declaring the operations as a type gives the dispatch call site the same
 * checking a direct call would have had.
 */
export type OperationMap<State extends StateShape> = Record<
  string,
  (draft: Draft<State>, payload: never) => void
>;

export type PayloadOf<
  Operations extends OperationMap<StateShape>,
  Name extends keyof Operations,
> = Operations[Name] extends (draft: never, payload: infer Payload) => void ? Payload : never;

/** A dispatcher typed against the operations the owner registered. */
export interface TypedDispatcher<Operations extends OperationMap<StateShape>> {
  <Name extends keyof Operations & string>(
    operation: Name,
    payload: PayloadOf<Operations, Name>,
  ): Promise<number>;
}

/**
 * Declare a schema.
 *
 * Purely a type level helper: it returns its argument and exists so a state shape and its
 * operations can be declared in one place and referenced by type everywhere else.
 *
 *     const schema = defineSchema<AppState>()({
 *       increment: (draft, payload: { by: number }) => { draft.count += payload.by; },
 *     });
 *
 *     type Dispatch = TypedDispatcher<typeof schema>;
 */
export function defineSchema<State extends StateShape>() {
  return function operations<Operations extends OperationMap<State>>(
    definitions: Operations,
  ): Operations {
    return definitions;
  };
}
