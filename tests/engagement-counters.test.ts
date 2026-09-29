import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invariant behind "the like count and the heart agree": every engagement
 * read and every toggle reports the trigger-maintained counter column that the
 * feed renders, alongside the viewer's own flag, from the same response. A
 * toggle that re-counted the join table instead would report a different number
 * than the one on screen whenever a counter had drifted, which is what made the
 * heart fill while the tally beside it moved the wrong way.
 *
 * The fake below is deliberately *not* a trigger simulator: counters are values
 * in the fixture, so a test can put `posts.like_count` out of step with the
 * `likes` rows and show which number the client chooses.
 */

const VIEWER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const POST = "22222222-2222-4222-8222-222222222222";
const STORY = "33333333-3333-4333-8333-333333333333";
const STORY_OTHER = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;
type Filter =
  | { kind: "eq"; col: string; value: unknown }
  | { kind: "in"; col: string; values: Set<unknown> }
  | { kind: "gt"; col: string; value: unknown }
  | { kind: "is"; col: string; value: unknown };
type Op =
  | { kind: "select" }
  | { kind: "insert"; values: Row }
  | { kind: "update"; values: Row }
  | { kind: "delete" };

const store = vi.hoisted(() => ({
  tables: new Map<string, Row[]>(),
  queries: [] as string[],
  events: [] as { event: string; payload: Record<string, unknown> }[],
  // Set by `seed()` below: a `vi.hoisted` block runs before the constants in
  // this file exist, so the viewer id cannot be filled in here.
  viewer: "",
}));

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.kind === "eq" && row[f.col] !== f.value) return false;
    if (f.kind === "in" && !f.values.has(row[f.col])) return false;
    if (f.kind === "gt" && !(String(row[f.col]) > String(f.value))) return false;
    if (f.kind === "is" && row[f.col] !== f.value) return false;
  }
  return true;
}

class FakeQuery {
  private filters: Filter[] = [];
  private op: Op = { kind: "select" };
  private head = false;
  private wantCount = false;

  constructor(private table: string) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    this.op = { kind: "select" };
    this.head = Boolean(options?.head);
    this.wantCount = options?.count === "exact";
    return this;
  }
  insert(values: Row) {
    this.op = { kind: "insert", values };
    return this;
  }
  update(values: Row) {
    this.op = { kind: "update", values };
    return this;
  }
  delete() {
    this.op = { kind: "delete" };
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push({ kind: "eq", col, value });
    return this;
  }
  in(col: string, values: unknown[]) {
    this.filters.push({ kind: "in", col, values: new Set(values) });
    return this;
  }
  gt(col: string, value: unknown) {
    this.filters.push({ kind: "gt", col, value });
    return this;
  }
  is(col: string, value: unknown) {
    this.filters.push({ kind: "is", col, value });
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }

  private run(): { data: Row[] | null; count: number | null; error: null } {
    // Local copy: TypeScript drops a discriminant narrowing inside the
    // callbacks below if the check is on a mutable property.
    const op = this.op;
    store.queries.push(`${op.kind} ${this.table}`);
    const rows = store.tables.get(this.table) ?? [];
    if (op.kind === "insert") {
      store.tables.set(this.table, [...rows, op.values]);
      return { data: null, count: null, error: null };
    }
    if (op.kind === "update") {
      const patch = op.values;
      store.tables.set(
        this.table,
        rows.map((r) => (matches(r, this.filters) ? { ...r, ...patch } : r)),
      );
      return { data: null, count: null, error: null };
    }
    if (op.kind === "delete") {
      store.tables.set(
        this.table,
        rows.filter((r) => !matches(r, this.filters)),
      );
      return { data: null, count: null, error: null };
    }
    const found = rows.filter((r) => matches(r, this.filters));
    return {
      data: this.head ? null : found,
      count: this.wantCount || this.head ? found.length : null,
      error: null,
    };
  }

  maybeSingle() {
    const res = this.run();
    return { ...res, data: (res.data?.[0] ?? null) as Row | null };
  }
  single() {
    const res = this.run();
    const [first, ...rest] = res.data ?? [];
    if (!first || rest.length > 0)
      throw new Error(`single() on ${this.table} matched ${res.data?.length ?? 0} rows`);
    return { ...res, data: first };
  }
  then<T>(onFulfilled: (value: { data: Row[] | null; count: number | null; error: null }) => T) {
    return Promise.resolve(this.run()).then(onFulfilled);
  }
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => new FakeQuery(table),
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test" } } }),
      getUser: async () => ({ data: { user: { id: store.viewer } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    storage: { from: () => ({ upload: async () => ({ data: null, error: null }) }) },
    functions: { invoke: async () => ({ data: null, error: null }) },
    channel: () => ({ on: () => ({ subscribe: () => {} }), subscribe: () => {} }),
    removeChannel: async () => {},
  },
}));

vi.mock("@/lib/profile-service", () => ({
  get currentUserId() {
    return store.viewer;
  },
  get currentUser() {
    return { id: store.viewer };
  },
  cacheProfiles: () => {},
  rowToProfile: (row: Row) => row,
}));

vi.mock("@/lib/realtime", () => ({
  emitRealtime: (event: string, payload: Record<string, unknown>) =>
    store.events.push({ event, payload }),
  useRealtime: () => {},
}));

vi.mock("@/lib/moderation.functions", () => ({
  moderatePost: async () => ({}),
  moderateUser: async () => ({}),
  resolveReport: async () => ({}),
  saveSystemSettings: async () => ({}),
  terminateSpace: async () => ({}),
}));

vi.mock("@/lib/media.functions", () => ({ deleteMyMedia: async () => ({}) }));

const { getPostById, getStories, toggleBookmarkPost, toggleLikePost, toggleLikeStory } =
  await import("@/lib/api-client");

function seed(overrides: Record<string, Row[]> = {}) {
  store.tables.clear();
  store.queries.length = 0;
  store.events.length = 0;
  store.viewer = VIEWER;
  const tables: Record<string, Row[]> = {
    posts: [],
    likes: [],
    reposts: [],
    bookmarks: [],
    stories: [],
    story_likes: [],
    profiles: [],
    workspaces: [],
    workspace_members: [],
    ...overrides,
  };
  for (const [name, rows] of Object.entries(tables)) store.tables.set(name, rows);
}

function postRow(overrides: Row = {}): Row {
  return { id: POST, user_id: OTHER, content: "hi", hidden: false, like_count: 0, ...overrides };
}

function lastEmitted() {
  return store.events[store.events.length - 1];
}

// Every test starts from empty tables and no broadcast events, so an assertion
// about "nothing was emitted" means nothing.
beforeEach(() => seed());

describe("post like toggle", () => {
  it("reports the counter column the feed renders, not its own recount", async () => {
    // The exact drift that used to show: one like row, a tally of two on screen.
    seed({ posts: [postRow({ like_count: 2 })], likes: [] });

    const res = await toggleLikePost(POST);

    expect(res.liked).toBe(true);
    expect(res.likeCount).toBe(2);
    expect(store.tables.get("likes")).toHaveLength(1);
  });

  it("keeps the broadcast tally equal to the number it returns", async () => {
    seed({ posts: [postRow({ like_count: 5 })] });

    const res = await toggleLikePost(POST);

    expect(lastEmitted().event).toBe("post_like_updated");
    expect(lastEmitted().payload.likeCount).toBe(res.likeCount);
    expect(lastEmitted().payload.active).toBe(res.liked);
  });

  it("falls back to counting rows when the post row is unreadable", async () => {
    seed({ posts: [], likes: [] });

    const res = await toggleLikePost(POST);

    expect(res.liked).toBe(true);
    expect(res.likeCount).toBe(1);
  });

  it("never leaves a stale flag behind on a row that cannot be written", async () => {
    // Sample/demo content has a non-UUID id: no write, no optimistic echo.
    await expect(toggleLikePost("post_seed_2")).rejects.toThrow(/sample content/);
    expect(store.events).toHaveLength(0);
  });

  it("refuses silently-ignored writes for guests instead of faking success", async () => {
    seed({ posts: [postRow({ like_count: 2 })] });
    store.viewer = "guest";

    await expect(toggleLikePost(POST)).rejects.toThrow(/sign in/i);
    expect(store.tables.get("likes")).toHaveLength(0);
  });

  it("bookmarks still work without a counter column", async () => {
    seed({ posts: [postRow({ like_count: 2 })] });

    const res = await toggleBookmarkPost(POST);

    expect(res).toEqual({ bookmarked: true });
    expect(store.tables.get("bookmarks")).toHaveLength(1);
  });
});

describe("story like toggle", () => {
  function storyRow(overrides: Row = {}): Row {
    return {
      id: STORY,
      user_id: OTHER,
      type: "gradient",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      view_count: 0,
      likes_count: 3,
      ...overrides,
    };
  }

  it("reports stories.likes_count, the number the story shows", async () => {
    seed({ stories: [storyRow({ likes_count: 3 })], story_likes: [] });

    const res = await toggleLikeStory(STORY);

    expect(res.liked).toBe(true);
    expect(res.likesCount).toBe(3);
  });

  it("hydrates the viewer's own like so the heart matches the tally on load", async () => {
    seed({
      stories: [storyRow({ likes_count: 1 }), storyRow({ id: STORY_OTHER, likes_count: 4 })],
      story_likes: [{ story_id: STORY, user_id: VIEWER }],
    });

    const stories = await getStories();

    const mine = stories.find((s) => s.id === STORY);
    const theirs = stories.find((s) => s.id === STORY_OTHER);
    expect(mine?.likedByMe).toBe(true);
    expect(mine?.likes_count).toBe(1);
    expect(theirs?.likedByMe).toBe(false);
    expect(theirs?.likes_count).toBe(4);
  });

  it("surfaces a failed like write rather than returning a made-up state", async () => {
    seed({ stories: [storyRow()], story_likes: [] });
    store.viewer = "guest";

    await expect(toggleLikeStory(STORY)).rejects.toThrow(/sign in/i);
    expect(store.tables.get("story_likes")).toHaveLength(0);
  });
});

describe("engagement on load", () => {
  it("gives a single post both the flag and the tally from the same read", async () => {
    seed({
      posts: [postRow({ like_count: 7 })],
      likes: [{ post_id: POST, user_id: VIEWER }],
    });

    const post = await getPostById(POST);

    expect(post?.likedByMe).toBe(true);
    expect(post?.likeCount).toBe(7);
  });

  it("does not claim a like for a viewer who has none", async () => {
    seed({
      posts: [postRow({ like_count: 7 })],
      likes: [{ post_id: POST, user_id: OTHER }],
    });

    const post = await getPostById(POST);

    expect(post?.likedByMe).toBe(false);
    expect(post?.likeCount).toBe(7);
  });
});
