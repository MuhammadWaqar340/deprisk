export declare function merge(a: object, b: object): object;
export declare function get(obj: object, path: string, defaultValue?: unknown): unknown;
export declare function map<T, U>(collection: T[], iteratee: (item: T) => U): U[];
export declare const VERSION: string;

export interface Options {
  deep: boolean;
  clone: boolean;
}

export type Result = "ok" | "error";

export * from "./helpers";
