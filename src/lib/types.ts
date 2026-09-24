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
    system_health: {
      status: "operational" | "degraded" | "maintenance";
      uptime_seconds: number;
      database_latency_ms: number;
      storage_usage_bytes: number;
      error_rate_percent: number;
      db_driver?: string;
      memory_mb?: number;
      active_sse_clients?: number;
    };
  };
  storage_usage_breakdown: {
    avatars_mb: number;
    posts_media_mb: number;
    stories_mb: number;
    spaces_audio_mb: number;
  };
  charts: AdminCharts;
  recent_activity?: any[];
  recent_reports?: any[];
}

export interface PollVote {
  option_id: string;
  user_id: string;
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
}

export interface PostComment {
  id: string;
  post_id?: string;
  user_id: string;
  content: string;
  created_at: string;
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
  gradient: string;
  recorded?: boolean;
  duration?: string;
  recording_url?: string;
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
  is_edited?: boolean;
}

export interface Conversation {
  id: string;
  participant_id: string;
  preview: string;
  unread: number;
  online: boolean;
  updated_at: string;
  messages?: Message[];
}

export type NotificationType =
  "like" | "repost" | "comment" | "reply" | "follow" | "mention" | "space" | "tip";

export interface Notification {
  id: string;
  actor_id: string;
  recipient_id?: string;
  type: NotificationType;
  body: string;
  created_at: string;
  read: boolean;
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
  liked?: boolean;
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
