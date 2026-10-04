export type UserRole = "superadmin" | "admin" | "moderator" | "analyst" | "community" | "user";
export type UserStatus = "active" | "suspended" | "flagged" | "banned";

export interface Profile {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  location: string;
  website: string;
  followers: number;
  following: number;
  verified: boolean;
  plan?: "free" | "plus" | "pro";
  role?: UserRole;
  status?: UserStatus;
  warning_count?: number;
  joined_at?: string;
  email?: string;
  last_active?: string;
}

export interface AuditLog {
  id: string;
  actor_id: string;
  actor_name: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  details: string;
  ip_address: string;
  created_at: string;
  severity: "info" | "warning" | "danger" | "success";
}

export interface ModerationReport {
  id: string;
  target_type: "post" | "user" | "story" | "comment" | "space";
  target_id: string;
  target_preview?: string;
  author_id?: string;
  author_name?: string;
  reporter_id: string;
  reporter_name: string;
  reason:
    | "spam"
    | "harassment"
    | "inappropriate"
    | "impersonation"
    | "copyright"
    | "misinformation"
    | "other";
  details: string;
  status: "pending" | "investigating" | "resolved" | "dismissed";
  created_at: string;
  action_taken?: string;
}

export interface SystemSettings {
  maintenance_mode: boolean;
  registration_enabled: boolean;
  ai_generation_enabled: boolean;
  stories_enabled: boolean;
  spaces_audio_enabled: boolean;
  max_upload_size_mb: number;
  rate_limit_requests_per_min: number;
  auto_mod_strictness: "low" | "medium" | "high" | "strict";
  announcement_banner: {
    active: boolean;
    message: string;
    type: "info" | "warning" | "success" | "critical";
    link?: string;
    dismissible: boolean;
  };
}

export interface AdminCharts {
  daily_impressions: { date: string; impressions: number; engagement: number }[];
  engagement_distribution: { name: string; value: number; color: string }[];
  hourly_traffic: { hour: string; requests: number }[];
  system_load_timeline: { time: string; cpu: number; memory: number }[];
  top_creators: {
    id: string;
    name: string;
    username: string;
    verified: boolean;
    impressions: number;
    followers: number;
    posts: number;
  }[];
  category_velocity: { tag: string; count: number; growth: string }[];
}

export interface AdminOverviewData {
  stats: {
    total_users: number;
    active_24h_users: number;
    total_posts: number;
    total_stories: number;
    total_spaces: number;
    live_spaces_count: number;
    total_impressions: number;
    total_likes: number;
    total_comments: number;
    total_reposts: number;
    pending_reports_count: number;
    suspended_users_count: number;
    verified_creators_count: number;
    /** Platform tipping activity: volume + newest tips for the admin overview. */
    total_tips_count?: number;
    total_tips_amount?: number;
    tips_currency?: string;
    system_health: {
      status: "operational" | "degraded" | "maintenance";
      uptime_seconds: number;
      database_latency_ms: number;
      error_rate_percent: number;
      db_driver?: string;
      memory_mb?: number;
      active_sse_clients?: number;
    };
  };
  charts: AdminCharts;
  recent_activity?: any[];
  recent_reports?: any[];
  recent_tips?: {
    id: string;
    tipper: string;
    recipient: string;
    amount: number;
    currency: string;
    message: string;
    created_at: string;
  }[];
}

export interface PollOption {
  id: string;
  text: string;
  votes: number;
  votedByMe?: boolean;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  totalVotes: number;
  hasVoted?: boolean;
  userVotedOptionId?: string;
  closed?: boolean;
  /**
   * The tally read failed, so `totalVotes` and the per-option counts are *not*
   * known. Set by `hydratePolls`/`votePoll` so the card can say "counts aren't
   * loading" instead of drawing a live poll as an empty result.
   */
  resultsUnavailable?: boolean;
}

export interface PostComment {
  id: string;
  post_id?: string;
  user_id: string;
  content: string;
  created_at: string;
  parent_id?: string | null;
  edited_at?: string | null;
}

export type Comment = PostComment;

export interface Post {
  id: string;
  user_id: string;
  content: string;
  image_gradient?: string | null;
  media_url?: string | null;
  image_url?: string | null;
  tags: string[];
  created_at: string;
  likeCount: number;
  commentCount: number;
  repostCount: number;
  viewCount: number;
  likedByMe?: boolean;
  bookmarkedByMe?: boolean;
  repostedByMe?: boolean;
  poll?: Poll | null;
  comments?: PostComment[];
  edited_at?: string | null;
  /** Staff hid this from every feed without deleting it (`posts.hidden`). */
  hidden?: boolean;
  /** Media three separate reporters called inappropriate, or a staff decision.
   *  Reader-controlled: Settings > Privacy decides whether it arrives blurred. */
  is_sensitive?: boolean;
  /** Who decided the above — `community` | `staff` — used for the wording only. */
  sensitive_source?: string | null;
  /** Set when the post was published on behalf of a team workspace. */
  workspace_id?: string | null;
  /** Hydrated brand identity for workspace posts (shown instead of the member). */
  workspace?: WorkspaceIdentity | null;
}

export interface WorkspaceIdentity {
  id: string;
  name: string;
  logoEmoji: string;
  avatarUrl: string | null;
}

export interface SpaceParticipant {
  id: string;
  role: "host" | "speaker" | "listener";
  handRaised?: boolean;
  isMuted?: boolean;
  isSpeaking?: boolean;
}

export interface SpaceChatMessage {
  id: string;
  userId: string;
  name: string;
  body: string;
  createdAt: string;
}

export interface Space {
  id: string;
  title: string;
  host_id: string;
  host_name?: string;
  topic: string;
  listeners: number;
  live: boolean;
  is_live?: boolean;
  startsIn?: string;
  starts_at?: string | null;
  gradient: string;
  recorded?: boolean;
  duration?: string;
  recording_url?: string;
  is_recording?: boolean;
  replay_count?: number;
  participants?: SpaceParticipant[];
  messages?: SpaceChatMessage[];
}

export interface Message {
  id: string;
  sender_id: string;
  conversation_id?: string;
  body: string;
  created_at: string;
  media_url?: string | null;
  read_at?: string | null;
  delivered_at?: string | null;
  /** Persisted edit marker — the source of `is_edited` on hydration. */
  edited_at?: string | null;
  /** Viewer-scoped tombstones: users who chose "Delete for me" on this row. */
  hidden_for?: string[];
  is_edited?: boolean;
}

export interface Conversation {
  id: string;
  participant_id: string;
  preview: string;
  unread: number;
  online: boolean;
  updated_at: string;
  /** Per-user hide list — cleared automatically when a new message arrives. */
  hidden_for?: string[];
  messages?: Message[];
}

export type NotificationType =
  | "like"
  | "repost"
  | "comment"
  | "reply"
  | "follow"
  | "mention"
  | "space"
  | "tip"
  | "payout"
  | "system"
  | "story_like"
  | "message"
  | "workspace_invite"
  | "workspace";

export interface Notification {
  id: string;
  /** Null for platform notices (payout confirmations, staff/system messages). */
  actor_id: string | null;
  recipient_id?: string;
  post_id?: string | null;
  type: NotificationType;
  body: string;
  created_at: string;
  read: boolean;
  /** Stamped by the workspace-invite DB trigger; drives the inline accept/decline. */
  action?: {
    kind: string;
    member_id: string;
    workspace_id: string;
    state: string;
  };
}

export interface TrendingTag {
  tag: string;
  category: string;
  count: string;
}

export interface Topic {
  name: string;
  gradient: string;
  posts: string;
}

export interface Story {
  id: string;
  user_id: string;
  user_name?: string;
  type: "gradient" | "image" | "quote";
  gradient?: string;
  image_url?: string;
  media_url?: string;
  text?: string;
  caption?: string;
  created_at: string;
  expires_at: string;
  view_count: number;
  /**
   * Whether the *viewer* liked this story. `getStories()` hydrates it from
   * `story_likes` so the heart matches `likes_count`, which already includes
   * their like. One field on purpose: a second `liked` flag let the two disagree.
   */
  likedByMe?: boolean;
  likes_count?: number;
  location?: string;
  mood?: string;
  stickers?: Array<string | { emoji: string; x?: number; y?: number }>;
}

export interface UserFeedPreferences {
  algorithm?: "for_you_smart" | "chronological" | "media_heavy" | "text_dense";
  preferred_tags?: string[];
  preferredTags?: string[];
  hidden_tags?: string[];
  content_freshness_weight?: number;
  creator_affinity_weight?: number;
  enable_ai_reranking?: boolean;
  serendipityLevel?: "focused" | "balanced" | "adventurous" | "low" | "high";
  topicAffinities?: Record<string, number>;
  mutedTags?: string[];
  mutedAuthors?: string[];
}

export interface FeedFeedbackPayload {
  postId: string;
  signal?: "see_more" | "see_less" | "hide_tag" | "mute_author" | "interested" | "not_interested";
  action?: "see_more" | "see_less" | "hide_tag" | "mute_author" | "interested" | "not_interested";
  tag?: string;
  authorId?: string;
}
