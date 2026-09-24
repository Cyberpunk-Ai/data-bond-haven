#!/usr/bin/env bash
# Applies every SQL migration (drizzle/migrations then database/migrations) in order.
# Usage: DATABASE_URL="postgresql://..." bun run db:migrate
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to your Postgres connection string}"
for f in drizzle/migrations/*.sql database/migrations/*.sql; do
  [ -f "$f" ] || continue
  echo "Applying $f"
  sed 's/--> statement-breakpoint//' "$f" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q
done
