/**
 * MediaIntegrityError lives in its own module so `integrity.ts` can re-export
 * it while `probe.ts` stays free of the import cycle.
 */
export class MediaIntegrityError extends Error {
  readonly path: string;
  readonly failures: string[];

  constructor(path: string, failures: string[]) {
    super(`media integrity check failed for ${path}: ${failures.join("; ")}`);
    this.name = "MediaIntegrityError";
    this.path = path;
    this.failures = failures;
  }
}
