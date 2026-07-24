/**
 * Thrown when a package cannot be API-analyzed because it has no TypeScript types.
 * Scan mode classifies this as SKIPPED (not ERROR).
 */
export class UntypedPackageError extends Error {
  readonly code = "UNTYPED" as const;
  readonly reason = "no-types" as const;

  constructor(
    readonly packageName: string,
    message: string,
  ) {
    super(message);
    this.name = "UntypedPackageError";
  }
}

export function isUntypedPackageError(err: unknown): err is UntypedPackageError {
  return err instanceof UntypedPackageError
    || (typeof err === "object"
      && err !== null
      && (err as { code?: string }).code === "UNTYPED");
}
