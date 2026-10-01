export type MigrationPin = { file: string; after: string };

/**
 * Files whose published prefix does not describe the slot they need, in the
 * position the production ledger records them in.
 */
export const SHIPPED_POSITION_PINS: MigrationPin[];

/** The leading digit run of a migration filename ("" when it has none). */
export function migrationVersion(name: string): string;

/** Exact numeric compare of two digit strings (no Number() rounding). */
export function compareNumericStrings(a: string, b: string): number;

/** Decimal-timestamp compare of two version digit runs. */
export function compareVersions(a: string, b: string): number;

/** Order migration filenames by version, then filename, then shipped pins. */
export function sortMigrationFiles<T extends string>(
  names: readonly T[],
  pins?: MigrationPin[],
): T[];

/** Pins that could not be honoured because a filename went missing. */
export function unresolvedPins(names: readonly string[], pins?: MigrationPin[]): MigrationPin[];

/** Filenames that claim the same version prefix, grouped. [] when all distinct. */
export function duplicateVersions(names: readonly string[]): string[][];
