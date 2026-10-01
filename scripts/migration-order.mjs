// =============================================================================
// Migration ordering, kept out of db-migrate.mjs so it can be unit-tested.
//
// Why this exists: `Array.prototype.sort()` on filenames is a *string* compare,
// and these names are zero-padded timestamps of DIFFERENT lengths. Three files
// were published with 15-digit prefixes, and the comparison reaches its
// decision on the 15th character:
//
//   "202609240000011_…"  <  "20260924000001_…"     (at index 14: "1" vs "_")
//
// so `…0000011_notifications_target_post.sql` ran its `alter table
// public.notifications` before the core schema created that table. Postgres
// answered 42P01, the run aborted, and a brand-new database could not be
// provisioned at all. Production only works because those files were applied
// interactively, in the order their authors needed.
//
// Two rules, in order of trustworthiness:
//
//  1. SHIPPED_POSITION_PINS — where a filename's prefix does not describe the
//     slot it actually needs, the pin records the position the live ledger
//     proves (public.schema_migrations.applied_at). `notifications_target_post`
//     rewrites trigger functions that `counters_notifications_triggers`
//     creates, so it must run *after* it, not before `grants_and_rls`.
//  2. Decimal timestamp compare for everything else: a prefix is
//     YYYYMMDDHHMMSS, so extra digits are a sub-second sequence —
//     202609240000011 is 2026-09-24 00:00:01.1 and belongs right after its
//     14-digit base. Done digit by digit, never through Number().
//
// Filenames are never renamed to fix ordering: the tracking table keys on
// `version` (the whole filename), so a rename would make every existing database
// replay that migration again.
// =============================================================================

const LEADING_DIGITS = /^(\d+)/;

/**
 * Files whose published prefix cannot be trusted to place them, pinned to the
 * position the production ledger records them in. `{ file, after }` means "runs
 * immediately after `after`". Remove a pin only by re-deriving the order from a
 * fresh replay, not by guessing.
 */
export const SHIPPED_POSITION_PINS = [
  {
    file: "202609240000030_messaging_calls_hardening.sql",
    after: "20260924000012_post_edit_and_indexes.sql",
  },
  {
    file: "202609240000011_notifications_target_post.sql",
    after: "202609240000030_messaging_calls_hardening.sql",
  },
  {
    file: "202609250000071_workspace_fixes_and_posts.sql",
    after: "20260924000070_lock_plan_escalation.sql",
  },
];

/** The leading digit run of a migration filename ("" when it has none). */
export function migrationVersion(name) {
  const base = name.replace(/^.*[\\/]/, "");
  const match = LEADING_DIGITS.exec(base);
  return match ? match[1] : "";
}

/**
 * Exact comparison of two digit strings of equal length (longer means larger —
 * callers normalise first). Deliberately no Number(): these prefixes are past
 * 2^53 already as soon as a sub-second digit is appended.
 */
export function compareNumericStrings(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Compare two version digit runs as decimal timestamps: the missing tail of a
 * shorter one is zeros, so `20260924000001` is `202609240000010` and sorts
 * before `202609240000011` (00:00:01 vs 00:00:01.1). Unversioned names go last —
 * they carry no timestamp to order by.
 */
export function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? "0";
    const right = b[i] ?? "0";
    if (left !== right) return left < right ? -1 : 1;
  }
  // 20260924000001 and 202609240000010 are the same instant: base before sequence.
  return a.length - b.length;
}

/** Place the pinned files where the shipped history says they ran. */
function applyPositionPins(ordered, pins) {
  const list = [...ordered];
  for (const { file, after } of pins) {
    const from = list.indexOf(file);
    if (from === -1 || list.indexOf(after) === -1) continue;
    list.splice(from, 1);
    list.splice(list.indexOf(after) + 1, 0, file);
  }
  return list;
}

/**
 * Order migration filenames by version, then by full filename (a stable
 * tiebreak for two files sharing a prefix), then apply the shipped pins.
 */
export function sortMigrationFiles(names, pins = SHIPPED_POSITION_PINS) {
  const ordered = [...names].sort((a, b) => {
    const byVersion = compareVersions(migrationVersion(a), migrationVersion(b));
    if (byVersion !== 0) return byVersion;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
  return applyPositionPins(ordered, pins);
}

/**
 * Pins that could not be honoured — the pinned file or its anchor is missing
 * from the folder (renamed, deleted). The runner warns instead of silently
 * trusting a prefix we already know to be wrong.
 */
export function unresolvedPins(names, pins = SHIPPED_POSITION_PINS) {
  const present = new Set(names);
  return pins.filter(({ file, after }) => !present.has(file) || !present.has(after));
}

/** Filenames that claim the same version prefix, grouped. [] when all distinct. */
export function duplicateVersions(names) {
  const byVersion = new Map();
  for (const name of names) {
    const version = migrationVersion(name);
    if (!version) continue;
    const group = byVersion.get(version);
    if (group) group.push(name);
    else byVersion.set(version, [name]);
  }
  return [...byVersion.values()].filter((group) => group.length > 1);
}
