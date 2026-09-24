export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      _probe: {
        Row: {
          id: number;
        };
        Insert: {
          id: number;
        };
        Update: {
          id?: number;
        };
        Relationships: [];
      };
      api_keys: {
        Row: {
          call_count: number;
          created_at: string;
          id: string;
          key_hash: string;
          last_used_at: string | null;
          name: string;
          prefix: string;
          revoked: boolean;
          scopes: Json;
          user_id: string;
        };
        Insert: {
          call_count?: number;
          created_at?: string;
          id?: string;
          key_hash: string;
          last_used_at?: string | null;
          name: string;
          prefix: string;
          revoked?: boolean;
          scopes?: Json;
          user_id: string;
        };
        Update: {
          call_count?: number;
          created_at?: string;
          id?: string;
          key_hash?: string;
          last_used_at?: string | null;
          name?: string;
          prefix?: string;
          revoked?: boolean;
          scopes?: Json;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "api_keys_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_logs: {
        Row: {
          action: string;
          actor_id: string | null;
          actor_name: string;
          actor_role: string;
          created_at: string;
          details: string;
          id: string;
          ip_address: string;
          severity: string;
          target_id: string;
          target_type: string;
        };
        Insert: {
          action: string;
          actor_id?: string | null;
          actor_name?: string;
          actor_role?: string;
          created_at?: string;
          details?: string;
          id?: string;
          ip_address?: string;
          severity?: string;
          target_id?: string;
          target_type?: string;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          actor_name?: string;
          actor_role?: string;
          created_at?: string;
          details?: string;
          id?: string;
          ip_address?: string;
          severity?: string;
          target_id?: string;
          target_type?: string;
        };
        Relationships: [];
      };
      bookmarks: {
        Row: {
          created_at: string;
          post_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          post_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          post_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "bookmarks_post_id_fkey";
            columns: ["post_id"];
            isOneToOne: false;
            referencedRelation: "posts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bookmarks_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      branding_settings: {
        Row: {
          post_aura: boolean;
          tagline: string;
          theme: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          post_aura?: boolean;
          tagline?: string;
          theme?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          post_aura?: boolean;
          tagline?: string;
          theme?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "branding_settings_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      calls: {
        Row: {
          answered_at: string | null;
          callee_id: string;
          caller_id: string;
          duration_seconds: number;
          ended_at: string | null;
          id: string;
          kind: string;
          started_at: string;
          status: string;
        };
        Insert: {
          answered_at?: string | null;
          callee_id: string;
          caller_id: string;
          duration_seconds?: number;
          ended_at?: string | null;
          id?: string;
          kind?: string;
          started_at?: string;
          status?: string;
        };
        Update: {
          answered_at?: string | null;
          callee_id?: string;
          caller_id?: string;
          duration_seconds?: number;
          ended_at?: string | null;
          id?: string;
          kind?: string;
          started_at?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calls_callee_id_fkey";
            columns: ["callee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calls_caller_id_fkey";
            columns: ["caller_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      comments: {
        Row: {
          content: string;
          created_at: string;
          id: string;
          post_id: string;
          user_id: string;
        };
        Insert: {
          content: string;
          created_at?: string;
          id?: string;
          post_id: string;
          user_id: string;
        };
        Update: {
          content?: string;
          created_at?: string;
          id?: string;
          post_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "comments_post_id_fkey";
            columns: ["post_id"];
            isOneToOne: false;
            referencedRelation: "posts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "comments_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      conversations: {
        Row: {
          created_at: string;
          id: string;
          preview: string;
          updated_at: string;
          user_a: string;
          user_b: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          preview?: string;
          updated_at?: string;
          user_a: string;
          user_b: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          preview?: string;
          updated_at?: string;
          user_a?: string;
          user_b?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversations_user_a_fkey";
            columns: ["user_a"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_user_b_fkey";
            columns: ["user_b"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      feed_preferences: {
        Row: {
          prefs: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          prefs?: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          prefs?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "feed_preferences_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      follows: {
        Row: {
          created_at: string;
          follower_id: string;
          target_id: string;
        };
        Insert: {
          created_at?: string;
          follower_id: string;
          target_id: string;
        };
        Update: {
          created_at?: string;
          follower_id?: string;
          target_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "follows_follower_id_fkey";
            columns: ["follower_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "follows_target_id_fkey";
            columns: ["target_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      likes: {
        Row: {
          created_at: string;
          post_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          post_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          post_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "likes_post_id_fkey";
            columns: ["post_id"];
            isOneToOne: false;
            referencedRelation: "posts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "likes_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      message_reactions: {
        Row: {
          created_at: string;
          emoji: string;
          message_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          emoji: string;
          message_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          emoji?: string;
          message_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_reactions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_reactions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          body: string;
          conversation_id: string;
          created_at: string;
          id: string;
          media_url: string | null;
          read_at: string | null;
          sender_id: string;
        };
        Insert: {
          body: string;
          conversation_id: string;
          created_at?: string;
          id?: string;
          media_url?: string | null;
          read_at?: string | null;
          sender_id: string;
        };
        Update: {
          body?: string;
          conversation_id?: string;
          created_at?: string;
          id?: string;
          media_url?: string | null;
          read_at?: string | null;
          sender_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_sender_id_fkey";
            columns: ["sender_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      monetization_settings: {
        Row: {
          bank_details: Json;
          created_at: string;
          crypto_details: Json;
          min_tip: number;
          payout_method: string;
          paystack_details: Json;
          stripe_details: Json;
          subscriptions_enabled: boolean;
          tips_enabled: boolean;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          bank_details?: Json;
          created_at?: string;
          crypto_details?: Json;
          min_tip?: number;
          payout_method?: string;
          paystack_details?: Json;
          stripe_details?: Json;
          subscriptions_enabled?: boolean;
          tips_enabled?: boolean;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          bank_details?: Json;
          created_at?: string;
          crypto_details?: Json;
          min_tip?: number;
          payout_method?: string;
          paystack_details?: Json;
          stripe_details?: Json;
          subscriptions_enabled?: boolean;
          tips_enabled?: boolean;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "monetization_settings_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      notifications: {
        Row: {
          actor_id: string | null;
          body: string;
          created_at: string;
          id: string;
          read: boolean;
          recipient_id: string;
          type: string;
        };
        Insert: {
          actor_id?: string | null;
          body: string;
          created_at?: string;
          id?: string;
          read?: boolean;
          recipient_id: string;
          type: string;
        };
        Update: {
          actor_id?: string | null;
          body?: string;
          created_at?: string;
          id?: string;
          read?: boolean;
          recipient_id?: string;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notifications_recipient_id_fkey";
            columns: ["recipient_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      payments: {
        Row: {
          amount: number;
          authorization_url: string | null;
          billing_cycle: string;
          created_at: string;
          currency: string;
          email: string | null;
          id: string;
          paid_at: string | null;
          plan: string;
          provider: string;
          raw: Json;
          reference: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          amount: number;
          authorization_url?: string | null;
          billing_cycle?: string;
          created_at?: string;
          currency?: string;
          email?: string | null;
          id?: string;
          paid_at?: string | null;
          plan: string;
          provider?: string;
          raw?: Json;
          reference: string;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          amount?: number;
          authorization_url?: string | null;
          billing_cycle?: string;
          created_at?: string;
          currency?: string;
          email?: string | null;
          id?: string;
          paid_at?: string | null;
          plan?: string;
          provider?: string;
          raw?: Json;
          reference?: string;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "payments_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      payouts: {
        Row: {
          amount: number;
          created_at: string;
          currency: string;
          destination: string | null;
          failure_reason: string | null;
          fee_amount: number;
          fee_bps: number;
          gross_amount: number | null;
          id: string;
          method: string;
          recipient_code: string | null;
          reference: string | null;
          status: string;
          transfer_code: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          amount: number;
          created_at?: string;
          currency?: string;
          destination?: string | null;
          failure_reason?: string | null;
          fee_amount?: number;
          fee_bps?: number;
          gross_amount?: number | null;
          id?: string;
          method?: string;
          recipient_code?: string | null;
          reference?: string | null;
          status?: string;
          transfer_code?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          amount?: number;
          created_at?: string;
          currency?: string;
          destination?: string | null;
          failure_reason?: string | null;
          fee_amount?: number;
          fee_bps?: number;
          gross_amount?: number | null;
          id?: string;
          method?: string;
          recipient_code?: string | null;
          reference?: string | null;
          status?: string;
          transfer_code?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "payouts_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      poll_votes: {
        Row: {
          created_at: string;
          option_id: string;
          post_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          option_id: string;
          post_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          option_id?: string;
          post_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "poll_votes_post_id_fkey";
            columns: ["post_id"];
            isOneToOne: false;
            referencedRelation: "posts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_votes_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      post_impressions: {
        Row: {
          created_at: string;
          id: string;
          post_id: string;
          user_id: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          post_id: string;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          post_id?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "post_impressions_post_id_fkey";
            columns: ["post_id"];
            isOneToOne: false;
            referencedRelation: "posts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "post_impressions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      posts: {
        Row: {
          comment_count: number;
          content: string;
          created_at: string;
          hidden: boolean;
          id: string;
          image_gradient: string | null;
          like_count: number;
          media_url: string | null;
          poll: Json | null;
          repost_count: number;
          tags: Json;
          user_id: string;
          view_count: number;
        };
        Insert: {
          comment_count?: number;
          content: string;
          created_at?: string;
          hidden?: boolean;
          id?: string;
          image_gradient?: string | null;
          like_count?: number;
          media_url?: string | null;
          poll?: Json | null;
          repost_count?: number;
          tags?: Json;
          user_id: string;
          view_count?: number;
        };
        Update: {
          comment_count?: number;
          content?: string;
          created_at?: string;
          hidden?: boolean;
          id?: string;
          image_gradient?: string | null;
          like_count?: number;
          media_url?: string | null;
          poll?: Json | null;
          repost_count?: number;
          tags?: Json;
          user_id?: string;
          view_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: "posts_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          auth_user_id: string | null;
          avatar_url: string | null;
          bio: string;
          created_at: string;
          display_name: string;
          followers: number;
          following: number;
          id: string;
          last_active: string;
          location: string;
          plan: string;
          status: string;
          updated_at: string;
          username: string;
          verified: boolean;
          warning_count: number;
          website: string;
        };
        Insert: {
          auth_user_id?: string | null;
          avatar_url?: string | null;
          bio?: string;
          created_at?: string;
          display_name: string;
          followers?: number;
          following?: number;
          id?: string;
          last_active?: string;
          location?: string;
          plan?: string;
          status?: string;
          updated_at?: string;
          username: string;
          verified?: boolean;
          warning_count?: number;
          website?: string;
        };
        Update: {
          auth_user_id?: string | null;
          avatar_url?: string | null;
          bio?: string;
          created_at?: string;
          display_name?: string;
          followers?: number;
          following?: number;
          id?: string;
          last_active?: string;
          location?: string;
          plan?: string;
          status?: string;
          updated_at?: string;
          username?: string;
          verified?: boolean;
          warning_count?: number;
          website?: string;
        };
        Relationships: [];
      };
      reports: {
        Row: {
          action_taken: string | null;
          author_id: string | null;
          author_name: string | null;
          created_at: string;
          details: string;
          id: string;
          reason: string;
          reporter_id: string;
          reporter_name: string;
          status: string;
          target_id: string;
          target_preview: string | null;
          target_type: string;
        };
        Insert: {
          action_taken?: string | null;
          author_id?: string | null;
          author_name?: string | null;
          created_at?: string;
          details?: string;
          id?: string;
          reason: string;
          reporter_id: string;
          reporter_name?: string;
          status?: string;
          target_id: string;
          target_preview?: string | null;
          target_type: string;
        };
        Update: {
          action_taken?: string | null;
          author_id?: string | null;
          author_name?: string | null;
          created_at?: string;
          details?: string;
          id?: string;
          reason?: string;
          reporter_id?: string;
          reporter_name?: string;
          status?: string;
          target_id?: string;
          target_preview?: string | null;
          target_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reports_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reports_reporter_id_fkey";
            columns: ["reporter_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      reposts: {
        Row: {
          created_at: string;
          post_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          post_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          post_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reposts_post_id_fkey";
            columns: ["post_id"];
            isOneToOne: false;
            referencedRelation: "posts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reposts_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      space_messages: {
        Row: {
          body: string;
          created_at: string;
          id: string;
          space_id: string;
          user_id: string;
        };
        Insert: {
          body: string;
          created_at?: string;
          id?: string;
          space_id: string;
          user_id: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          id?: string;
          space_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "space_messages_space_id_fkey";
            columns: ["space_id"];
            isOneToOne: false;
            referencedRelation: "spaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "space_messages_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      space_participants: {
        Row: {
          hand_raised: boolean;
          is_muted: boolean;
          is_speaking: boolean;
          joined_at: string;
          role: string;
          space_id: string;
          user_id: string;
        };
        Insert: {
          hand_raised?: boolean;
          is_muted?: boolean;
          is_speaking?: boolean;
          joined_at?: string;
          role?: string;
          space_id: string;
          user_id: string;
        };
        Update: {
          hand_raised?: boolean;
          is_muted?: boolean;
          is_speaking?: boolean;
          joined_at?: string;
          role?: string;
          space_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "space_participants_space_id_fkey";
            columns: ["space_id"];
            isOneToOne: false;
            referencedRelation: "spaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "space_participants_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      spaces: {
        Row: {
          created_at: string;
          duration: string | null;
          gradient: string;
          host_id: string;
          id: string;
          listeners: number;
          live: boolean;
          recorded: boolean;
          recording_url: string | null;
          starts_at: string | null;
          title: string;
          topic: string;
        };
        Insert: {
          created_at?: string;
          duration?: string | null;
          gradient?: string;
          host_id: string;
          id?: string;
          listeners?: number;
          live?: boolean;
          recorded?: boolean;
          recording_url?: string | null;
          starts_at?: string | null;
          title: string;
          topic?: string;
        };
        Update: {
          created_at?: string;
          duration?: string | null;
          gradient?: string;
          host_id?: string;
          id?: string;
          listeners?: number;
          live?: boolean;
          recorded?: boolean;
          recording_url?: string | null;
          starts_at?: string | null;
          title?: string;
          topic?: string;
        };
        Relationships: [
          {
            foreignKeyName: "spaces_host_id_fkey";
            columns: ["host_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      stories: {
        Row: {
          caption: string | null;
          created_at: string;
          expires_at: string;
          gradient: string | null;
          id: string;
          likes_count: number;
          location: string | null;
          media_url: string | null;
          mood: string | null;
          stickers: Json;
          text: string | null;
          type: string;
          user_id: string;
          view_count: number;
        };
        Insert: {
          caption?: string | null;
          created_at?: string;
          expires_at?: string;
          gradient?: string | null;
          id?: string;
          likes_count?: number;
          location?: string | null;
          media_url?: string | null;
          mood?: string | null;
          stickers?: Json;
          text?: string | null;
          type?: string;
          user_id: string;
          view_count?: number;
        };
        Update: {
          caption?: string | null;
          created_at?: string;
          expires_at?: string;
          gradient?: string | null;
          id?: string;
          likes_count?: number;
          location?: string | null;
          media_url?: string | null;
          mood?: string | null;
          stickers?: Json;
          text?: string | null;
          type?: string;
          user_id?: string;
          view_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: "stories_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      story_likes: {
        Row: {
          created_at: string;
          story_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          story_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          story_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "story_likes_story_id_fkey";
            columns: ["story_id"];
            isOneToOne: false;
            referencedRelation: "stories";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "story_likes_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      subscriptions: {
        Row: {
          ai_drafts_used: number;
          ai_usage_date: string;
          billing_cycle: string;
          created_at: string;
          payment_method: Json;
          plan: string;
          provider: string;
          provider_customer_id: string | null;
          provider_subscription_id: string | null;
          renews_at: string | null;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          ai_drafts_used?: number;
          ai_usage_date?: string;
          billing_cycle?: string;
          created_at?: string;
          payment_method?: Json;
          plan?: string;
          provider?: string;
          provider_customer_id?: string | null;
          provider_subscription_id?: string | null;
          renews_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          ai_drafts_used?: number;
          ai_usage_date?: string;
          billing_cycle?: string;
          created_at?: string;
          payment_method?: Json;
          plan?: string;
          provider?: string;
          provider_customer_id?: string | null;
          provider_subscription_id?: string | null;
          renews_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "subscriptions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      support_ticket_messages: {
        Row: {
          author_id: string | null;
          body: string;
          created_at: string;
          from_support: boolean;
          id: string;
          ticket_id: string;
        };
        Insert: {
          author_id?: string | null;
          body: string;
          created_at?: string;
          from_support?: boolean;
          id?: string;
          ticket_id: string;
        };
        Update: {
          author_id?: string | null;
          body?: string;
          created_at?: string;
          from_support?: boolean;
          id?: string;
          ticket_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "support_ticket_messages_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "support_ticket_messages_ticket_id_fkey";
            columns: ["ticket_id"];
            isOneToOne: false;
            referencedRelation: "support_tickets";
            referencedColumns: ["id"];
          },
        ];
      };
      support_tickets: {
        Row: {
          body: string;
          category: string;
          created_at: string;
          id: string;
          priority: string;
          status: string;
          subject: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          body?: string;
          category?: string;
          created_at?: string;
          id?: string;
          priority?: string;
          status?: string;
          subject: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          body?: string;
          category?: string;
          created_at?: string;
          id?: string;
          priority?: string;
          status?: string;
          subject?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "support_tickets_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      system_settings: {
        Row: {
          ai_generation_enabled: boolean;
          announcement_banner: Json;
          auto_mod_strictness: string;
          id: number;
          maintenance_mode: boolean;
          max_upload_size_mb: number;
          rate_limit_requests_per_min: number;
          registration_enabled: boolean;
          spaces_audio_enabled: boolean;
          stories_enabled: boolean;
          updated_at: string;
        };
        Insert: {
          ai_generation_enabled?: boolean;
          announcement_banner?: Json;
          auto_mod_strictness?: string;
          id?: number;
          maintenance_mode?: boolean;
          max_upload_size_mb?: number;
          rate_limit_requests_per_min?: number;
          registration_enabled?: boolean;
          spaces_audio_enabled?: boolean;
          stories_enabled?: boolean;
          updated_at?: string;
        };
        Update: {
          ai_generation_enabled?: boolean;
          announcement_banner?: Json;
          auto_mod_strictness?: string;
          id?: number;
          maintenance_mode?: boolean;
          max_upload_size_mb?: number;
          rate_limit_requests_per_min?: number;
          registration_enabled?: boolean;
          spaces_audio_enabled?: boolean;
          stories_enabled?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      tips: {
        Row: {
          amount: number;
          created_at: string;
          currency: string;
          fee_amount: number;
          fee_bps: number;
          from_user_id: string;
          id: string;
          message: string;
          net_amount: number;
          post_id: string | null;
          to_user_id: string;
        };
        Insert: {
          amount: number;
          created_at?: string;
          currency?: string;
          fee_amount?: number;
          fee_bps?: number;
          from_user_id: string;
          id?: string;
          message?: string;
          net_amount?: number;
          post_id?: string | null;
          to_user_id: string;
        };
        Update: {
          amount?: number;
          created_at?: string;
          currency?: string;
          fee_amount?: number;
          fee_bps?: number;
          from_user_id?: string;
          id?: string;
          message?: string;
          net_amount?: number;
          post_id?: string | null;
          to_user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tips_from_user_id_fkey";
            columns: ["from_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tips_post_id_fkey";
            columns: ["post_id"];
            isOneToOne: false;
            referencedRelation: "posts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tips_to_user_id_fkey";
            columns: ["to_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      user_preferences: {
        Row: {
          accent: string;
          larger_text: boolean;
          prefs: Json;
          reduce_motion: boolean;
          theme: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          accent?: string;
          larger_text?: boolean;
          prefs?: Json;
          reduce_motion?: boolean;
          theme?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          accent?: string;
          larger_text?: boolean;
          prefs?: Json;
          reduce_motion?: boolean;
          theme?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_preferences_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
      webhooks: {
        Row: {
          active: boolean;
          created_at: string;
          events: Json;
          id: string;
          url: string;
          user_id: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          events?: Json;
          id?: string;
          url: string;
          user_id: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          events?: Json;
          id?: string;
          url?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "webhooks_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_members: {
        Row: {
          created_at: string;
          email: string;
          id: string;
          name: string;
          role: string;
          status: string;
          user_id: string | null;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          email: string;
          id?: string;
          name?: string;
          role?: string;
          status?: string;
          user_id?: string | null;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          email?: string;
          id?: string;
          name?: string;
          role?: string;
          status?: string;
          user_id?: string | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspaces: {
        Row: {
          created_at: string;
          id: string;
          logo_emoji: string;
          name: string;
          owner_id: string;
          plan: string;
          seats_total: number;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          logo_emoji?: string;
          name: string;
          owner_id: string;
          plan?: string;
          seats_total?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          logo_emoji?: string;
          name?: string;
          owner_id?: string;
          plan?: string;
          seats_total?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspaces_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      current_profile_id: { Args: never; Returns: string };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      is_staff: { Args: never; Returns: boolean };
      is_workspace_member: {
        Args: { _profile_id: string; _workspace_id: string };
        Returns: boolean;
      };
      notify: {
        Args: {
          _actor: string;
          _body: string;
          _recipient: string;
          _type: string;
        };
        Returns: undefined;
      };
      owns_profile: { Args: { _profile_id: string }; Returns: boolean };
      platform_fee_bps: { Args: { _profile_id: string }; Returns: number };
    };
    Enums: {
      app_role: "user" | "moderator" | "admin";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["user", "moderator", "admin"],
    },
  },
} as const;
