#!/usr/bin/env bash
# Applies every SQL migration in supabase/migrations in order.
# Usage: DATABASE_URL="postgresql://..." bun run db:migrate
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to your Postgres connection string}"
for f in supabase/migrations/*.sql; do
  echo "Applying $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
done
