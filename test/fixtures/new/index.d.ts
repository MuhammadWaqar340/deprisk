/**
 * Deep-merge two objects. Array merge behavior was altered in v2.
 */
export declare function merge(a: object, b: object, opts?: { arrays?: "replace" | "concat" }): object;

/**
 * Get a nested value. The default-value parameter was removed.
 */
export declare function get(obj: object, path: string): unknown;

/** @deprecated Use `map` with Array.prototype instead */
export declare function mapValues<T>(obj: Record<string, T>, iteratee: (v: T) => T): Record<string, T>;

export declare function map<T, U>(collection: T[], iteratee: (item: T) => U): U[];

export declare const VERSION: string;

export interface Options {
  deep: boolean;
  clone: boolean;
  /** New option */
  strict?: boolean;
}

export type Result = "ok" | "error" | "pending";

export * from "./helpers";
