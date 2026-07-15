export declare function pick<T extends object>(obj: T, keys: (keyof T)[]): Partial<T>;
/** @deprecated Prefer Object.fromEntries */
export declare function omit<T extends object>(obj: T, keys: (keyof T)[]): Partial<T>;
export declare function flatten(arr: unknown[]): unknown[];
