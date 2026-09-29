export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string
          actor_id: string
          club_id: string
          created_at: string
          id: string
          metadata: Json | null
          target_id: string
          target_type: string
        }
        Insert: {
          action: string
          actor_id: string
          club_id: string
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id: string
          target_type: string
        }
        Update: {
          action?: string
          actor_id?: string
          club_id?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id?: string
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_feed_tokens: {
        Row: {
          club_id: string
          created_at: string
          feed_type: string
          id: string
          profile_id: string
          revoked_at: string | null
          token_hash: string
        }
        Insert: {
          club_id: string
          created_at?: string
          feed_type: string
          id?: string
          profile_id: string
          revoked_at?: string | null
          token_hash: string
        }
        Update: {
          club_id?: string
          created_at?: string
          feed_type?: string
          id?: string
          profile_id?: string
          revoked_at?: string | null
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_feed_tokens_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_feed_tokens_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      club_entitlements: {
        Row: {
          capability: string
          club_id: string
          created_at: string
          enabled: boolean
          granted_at: string
          granted_by: string | null
          id: string
          note: string | null
          revoked_at: string | null
          updated_at: string
        }
        Insert: {
          capability: string
          club_id: string
          created_at?: string
          enabled?: boolean
          granted_at?: string
          granted_by?: string | null
          id?: string
          note?: string | null
          revoked_at?: string | null
          updated_at?: string
        }
        Update: {
          capability?: string
          club_id?: string
          created_at?: string
          enabled?: boolean
          granted_at?: string
          granted_by?: string | null
          id?: string
          note?: string | null
          revoked_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_entitlements_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_entitlements_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      club_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          club_id: string
          code: string
          created_at: string
          created_by: string
          email: string | null
          expires_at: string
          id: string
          revoked_at: string | null
          role: string
          roster_member_id: string | null
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          club_id: string
          code?: string
          created_at?: string
          created_by: string
          email?: string | null
          expires_at?: string
          id?: string
          revoked_at?: string | null
          role?: string
          roster_member_id?: string | null
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          club_id?: string
          code?: string
          created_at?: string
          created_by?: string
          email?: string | null
          expires_at?: string
          id?: string
          revoked_at?: string | null
          role?: string
          roster_member_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "club_invites_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_invites_roster_member_id_fkey"
            columns: ["roster_member_id"]
            isOneToOne: false
            referencedRelation: "roster_members"
            referencedColumns: ["id"]
          },
        ]
      }
      club_memberships: {
        Row: {
          club_id: string
          created_at: string
          id: string
          invited_by: string | null
          is_lesson_provider: boolean
          joined_at: string
          removed_at: string | null
          removed_by: string | null
          role: string
          source_invite_id: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          club_id: string
          created_at?: string
          id?: string
          invited_by?: string | null
          is_lesson_provider?: boolean
          joined_at?: string
          removed_at?: string | null
          removed_by?: string | null
          role?: string
          source_invite_id?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          club_id?: string
          created_at?: string
          id?: string
          invited_by?: string | null
          is_lesson_provider?: boolean
          joined_at?: string
          removed_at?: string | null
          removed_by?: string | null
          role?: string
          source_invite_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_memberships_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_memberships_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_memberships_removed_by_fkey"
            columns: ["removed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_memberships_source_invite_id_fkey"
            columns: ["source_invite_id"]
            isOneToOne: false
            referencedRelation: "club_invites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      club_settings: {
        Row: {
          booking_window_days: number
          cancellation_grace_minutes: number
          cancellation_window_hours: number
          club_id: string
          created_at: string
          currency: string
          default_court_hourly_rate_cents: number | null
          default_court_hourly_rate_non_member_cents: number | null
          id: string
          memberships_enabled: boolean
          payment_mode: string
          rules_and_policies: string | null
          updated_at: string
          waitlist_offer_window_hours: number
        }
        Insert: {
          booking_window_days?: number
          cancellation_grace_minutes?: number
          cancellation_window_hours?: number
          club_id: string
          created_at?: string
          currency?: string
          default_court_hourly_rate_cents?: number | null
          default_court_hourly_rate_non_member_cents?: number | null
          id?: string
          memberships_enabled?: boolean
          payment_mode?: string
          rules_and_policies?: string | null
          updated_at?: string
          waitlist_offer_window_hours?: number
        }
        Update: {
          booking_window_days?: number
          cancellation_grace_minutes?: number
          cancellation_window_hours?: number
          club_id?: string
          created_at?: string
          currency?: string
          default_court_hourly_rate_cents?: number | null
          default_court_hourly_rate_non_member_cents?: number | null
          id?: string
          memberships_enabled?: boolean
          payment_mode?: string
          rules_and_policies?: string | null
          updated_at?: string
          waitlist_offer_window_hours?: number
        }
        Relationships: [
          {
            foreignKeyName: "club_settings_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: true
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      club_stripe_accounts: {
        Row: {
          card_payments_status: string
          club_id: string
          created_at: string
          created_by: string | null
          id: string
          last_synced_at: string | null
          livemode: boolean
          stripe_account_id: string
          updated_at: string
        }
        Insert: {
          card_payments_status?: string
          club_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          last_synced_at?: string | null
          livemode: boolean
          stripe_account_id: string
          updated_at?: string
        }
        Update: {
          card_payments_status?: string
          club_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          last_synced_at?: string | null
          livemode?: boolean
          stripe_account_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_stripe_accounts_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_stripe_accounts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      club_subscriptions: {
        Row: {
          billing_period: string | null
          club_id: string
          created_at: string
          current_period_end: string | null
          id: string
          source: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          tier: string
          updated_at: string
        }
        Insert: {
          billing_period?: string | null
          club_id: string
          created_at?: string
          current_period_end?: string | null
          id?: string
          source: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tier: string
          updated_at?: string
        }
        Update: {
          billing_period?: string | null
          club_id?: string
          created_at?: string
          current_period_end?: string | null
          id?: string
          source?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tier?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_subscriptions_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: true
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      clubs: {
        Row: {
          created_at: string
          id: string
          logo_url: string | null
          name: string
          slug: string
          theme_key: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          logo_url?: string | null
          name: string
          slug: string
          theme_key?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          logo_url?: string | null
          name?: string
          slug?: string
          theme_key?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      court_rate_periods: {
        Row: {
          club_id: string
          created_at: string
          days_of_week: number[]
          ends_at_local: string
          hourly_rate_cents: number | null
          hourly_rate_non_member_cents: number | null
          id: string
          is_active: boolean
          name: string
          starts_at_local: string
          updated_at: string
        }
        Insert: {
          club_id: string
          created_at?: string
          days_of_week: number[]
          ends_at_local: string
          hourly_rate_cents?: number | null
          hourly_rate_non_member_cents?: number | null
          id?: string
          is_active?: boolean
          name: string
          starts_at_local: string
          updated_at?: string
        }
        Update: {
          club_id?: string
          created_at?: string
          days_of_week?: number[]
          ends_at_local?: string
          hourly_rate_cents?: number | null
          hourly_rate_non_member_cents?: number | null
          id?: string
          is_active?: boolean
          name?: string
          starts_at_local?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "court_rate_periods_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      courts: {
        Row: {
          club_id: string
          created_at: string
          display_order: number
          hourly_rate_cents: number | null
          hourly_rate_non_member_cents: number | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          club_id: string
          created_at?: string
          display_order?: number
          hourly_rate_cents?: number | null
          hourly_rate_non_member_cents?: number | null
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          club_id?: string
          created_at?: string
          display_order?: number
          hourly_rate_cents?: number | null
          hourly_rate_non_member_cents?: number | null
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "courts_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      event_guests: {
        Row: {
          added_by: string
          attendance_status: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          display_name: string
          event_id: string
          id: string
          price_amount_cents: number | null
          roster_member_id: string | null
          status: string
        }
        Insert: {
          added_by: string
          attendance_status?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          display_name: string
          event_id: string
          id?: string
          price_amount_cents?: number | null
          roster_member_id?: string | null
          status?: string
        }
        Update: {
          added_by?: string
          attendance_status?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          display_name?: string
          event_id?: string
          id?: string
          price_amount_cents?: number | null
          roster_member_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_guests_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_guests_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_guests_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_guests_roster_member_id_fkey"
            columns: ["roster_member_id"]
            isOneToOne: false
            referencedRelation: "roster_members"
            referencedColumns: ["id"]
          },
        ]
      }
      event_participants: {
        Row: {
          attendance_status: string | null
          cancelled_at: string | null
          confirmed_at: string | null
          created_at: string
          event_id: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          role: string
          roster_member_id: string
          status: string
          updated_at: string
        }
        Insert: {
          attendance_status?: string | null
          cancelled_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          event_id: string
          id?: string
          offer_expires_at?: string | null
          price_amount_cents?: number | null
          profile_id?: string | null
          role?: string
          roster_member_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          attendance_status?: string | null
          cancelled_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          event_id?: string
          id?: string
          offer_expires_at?: string | null
          price_amount_cents?: number | null
          profile_id?: string | null
          role?: string
          roster_member_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_participants_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_participants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_participants_roster_member_id_fkey"
            columns: ["roster_member_id"]
            isOneToOne: false
            referencedRelation: "roster_members"
            referencedColumns: ["id"]
          },
        ]
      }
      event_types: {
        Row: {
          club_id: string
          color: string
          created_at: string
          default_capacity: number
          default_court_count: number
          default_duration_minutes: number
          default_price_amount_cents: number | null
          id: string
          is_active: boolean
          key: string
          label: string
          shows_participant_names: boolean
          updated_at: string
        }
        Insert: {
          club_id: string
          color: string
          created_at?: string
          default_capacity: number
          default_court_count: number
          default_duration_minutes: number
          default_price_amount_cents?: number | null
          id?: string
          is_active?: boolean
          key: string
          label: string
          shows_participant_names?: boolean
          updated_at?: string
        }
        Update: {
          club_id?: string
          color?: string
          created_at?: string
          default_capacity?: number
          default_court_count?: number
          default_duration_minutes?: number
          default_price_amount_cents?: number | null
          id?: string
          is_active?: boolean
          key?: string
          label?: string
          shows_participant_names?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_types_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          archived_at: string | null
          archived_by: string | null
          cancelled_at: string | null
          capacity: number
          club_id: string
          court_count: number
          created_at: string
          created_by: string
          description: string | null
          ends_at: string
          event_type_id: string
          id: string
          is_program_exception: boolean
          member_joinable: boolean
          price_amount_cents: number | null
          program_id: string | null
          program_occurrence_date: string | null
          program_schedule_rule_id: string | null
          starts_at: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          archived_by?: string | null
          cancelled_at?: string | null
          capacity: number
          club_id: string
          court_count?: number
          created_at?: string
          created_by: string
          description?: string | null
          ends_at: string
          event_type_id: string
          id?: string
          is_program_exception?: boolean
          member_joinable?: boolean
          price_amount_cents?: number | null
          program_id?: string | null
          program_occurrence_date?: string | null
          program_schedule_rule_id?: string | null
          starts_at: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          archived_by?: string | null
          cancelled_at?: string | null
          capacity?: number
          club_id?: string
          court_count?: number
          created_at?: string
          created_by?: string
          description?: string | null
          ends_at?: string
          event_type_id?: string
          id?: string
          is_program_exception?: boolean
          member_joinable?: boolean
          price_amount_cents?: number | null
          program_id?: string | null
          program_occurrence_date?: string | null
          program_schedule_rule_id?: string | null
          starts_at?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_event_type_id_fkey"
            columns: ["event_type_id"]
            isOneToOne: false
            referencedRelation: "event_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_program_rule_fkey"
            columns: ["program_schedule_rule_id", "program_id"]
            isOneToOne: false
            referencedRelation: "program_schedule_rules"
            referencedColumns: ["id", "program_id"]
          },
        ]
      }
      guest_waiver_acceptances: {
        Row: {
          accepted_at: string
          club_id: string
          event_guest_id: string | null
          id: string
          invitation_id: string | null
          reservation_guest_id: string | null
          waiver_version_id: string
        }
        Insert: {
          accepted_at?: string
          club_id: string
          event_guest_id?: string | null
          id?: string
          invitation_id?: string | null
          reservation_guest_id?: string | null
          waiver_version_id: string
        }
        Update: {
          accepted_at?: string
          club_id?: string
          event_guest_id?: string | null
          id?: string
          invitation_id?: string | null
          reservation_guest_id?: string | null
          waiver_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_waiver_acceptances_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_waiver_acceptances_event_guest_id_fkey"
            columns: ["event_guest_id"]
            isOneToOne: false
            referencedRelation: "event_guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_waiver_acceptances_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "guest_waiver_invitations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_waiver_acceptances_reservation_guest_id_fkey"
            columns: ["reservation_guest_id"]
            isOneToOne: false
            referencedRelation: "reservation_guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_waiver_acceptances_waiver_version_id_fkey"
            columns: ["waiver_version_id"]
            isOneToOne: false
            referencedRelation: "waiver_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_waiver_invitations: {
        Row: {
          club_id: string
          created_at: string
          created_by: string
          event_guest_id: string | null
          id: string
          reservation_guest_id: string | null
          revoked_at: string | null
          revoked_by: string | null
          token_hash: string
        }
        Insert: {
          club_id: string
          created_at?: string
          created_by: string
          event_guest_id?: string | null
          id?: string
          reservation_guest_id?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          token_hash: string
        }
        Update: {
          club_id?: string
          created_at?: string
          created_by?: string
          event_guest_id?: string | null
          id?: string
          reservation_guest_id?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_waiver_invitations_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_waiver_invitations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_waiver_invitations_event_guest_id_fkey"
            columns: ["event_guest_id"]
            isOneToOne: false
            referencedRelation: "event_guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_waiver_invitations_reservation_guest_id_fkey"
            columns: ["reservation_guest_id"]
            isOneToOne: false
            referencedRelation: "reservation_guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_waiver_invitations_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lesson_requests: {
        Row: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        Insert: {
          cancellation_policy_state?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          club_id: string
          confirmed_at?: string | null
          created_at?: string
          decline_reason?: string | null
          declined_at?: string | null
          duration_minutes: number
          id?: string
          last_actor_id?: string | null
          last_actor_role?: string | null
          lesson_outcome?: string | null
          lesson_type_id?: string | null
          linked_reservation_id?: string | null
          member_id?: string | null
          member_note?: string | null
          preferred_court_id?: string | null
          preferred_windows?: Json | null
          price_amount_cents?: number | null
          pricing_basis?: string | null
          pro_id: string
          proposed_court_id?: string | null
          proposed_ends_at?: string | null
          proposed_starts_at?: string | null
          roster_member_id: string
          status?: string
          unit_price_amount_cents?: number | null
          updated_at?: string
        }
        Update: {
          cancellation_policy_state?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          club_id?: string
          confirmed_at?: string | null
          created_at?: string
          decline_reason?: string | null
          declined_at?: string | null
          duration_minutes?: number
          id?: string
          last_actor_id?: string | null
          last_actor_role?: string | null
          lesson_outcome?: string | null
          lesson_type_id?: string | null
          linked_reservation_id?: string | null
          member_id?: string | null
          member_note?: string | null
          preferred_court_id?: string | null
          preferred_windows?: Json | null
          price_amount_cents?: number | null
          pricing_basis?: string | null
          pro_id?: string
          proposed_court_id?: string | null
          proposed_ends_at?: string | null
          proposed_starts_at?: string | null
          roster_member_id?: string
          status?: string
          unit_price_amount_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lesson_requests_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_requests_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_requests_last_actor_id_fkey"
            columns: ["last_actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_requests_lesson_type_id_fkey"
            columns: ["lesson_type_id"]
            isOneToOne: false
            referencedRelation: "lesson_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_requests_linked_reservation_id_fkey"
            columns: ["linked_reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_requests_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_requests_preferred_court_id_fkey"
            columns: ["preferred_court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_requests_pro_id_fkey"
            columns: ["pro_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_requests_proposed_court_id_fkey"
            columns: ["proposed_court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_requests_roster_member_id_fkey"
            columns: ["roster_member_id"]
            isOneToOne: false
            referencedRelation: "roster_members"
            referencedColumns: ["id"]
          },
        ]
      }
      lesson_types: {
        Row: {
          allowed_durations: number[] | null
          club_id: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          max_participants: number
          name: string
          pricing_basis: string
          rate_notes: string | null
          unit_price_amount_cents: number | null
          updated_at: string
        }
        Insert: {
          allowed_durations?: number[] | null
          club_id: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          max_participants?: number
          name: string
          pricing_basis?: string
          rate_notes?: string | null
          unit_price_amount_cents?: number | null
          updated_at?: string
        }
        Update: {
          allowed_durations?: number[] | null
          club_id?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          max_participants?: number
          name?: string
          pricing_basis?: string
          rate_notes?: string | null
          unit_price_amount_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lesson_types_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      member_notes: {
        Row: {
          archived_at: string | null
          archived_by: string | null
          author_id: string | null
          author_name_snapshot: string
          body: string
          club_id: string
          created_at: string
          id: string
          is_archived: boolean
          member_id: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          archived_by?: string | null
          author_id?: string | null
          author_name_snapshot: string
          body: string
          club_id: string
          created_at?: string
          id?: string
          is_archived?: boolean
          member_id: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          archived_by?: string | null
          author_id?: string | null
          author_name_snapshot?: string
          body?: string
          club_id?: string
          created_at?: string
          id?: string
          is_archived?: boolean
          member_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_notes_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_notes_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_notes_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      membership_types: {
        Row: {
          club_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          club_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          club_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "membership_types_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_deliveries: {
        Row: {
          channel: string
          club_id: string
          created_at: string
          error: string | null
          id: string
          notification_id: string
          provider: string | null
          provider_message_id: string | null
          sent_at: string | null
          status: string
        }
        Insert: {
          channel: string
          club_id: string
          created_at?: string
          error?: string | null
          id?: string
          notification_id: string
          provider?: string | null
          provider_message_id?: string | null
          sent_at?: string | null
          status: string
        }
        Update: {
          channel?: string
          club_id?: string
          created_at?: string
          error?: string | null
          id?: string
          notification_id?: string
          provider?: string | null
          provider_message_id?: string | null
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_deliveries_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          club_id: string
          enabled: boolean
          id: string
          kind: string
          updated_at: string
          user_id: string
        }
        Insert: {
          club_id: string
          enabled?: boolean
          id?: string
          kind: string
          updated_at?: string
          user_id: string
        }
        Update: {
          club_id?: string
          enabled?: boolean
          id?: string
          kind?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string
          club_id: string
          created_at: string
          id: string
          is_read: boolean
          kind: string
          metadata: Json | null
          user_id: string
        }
        Insert: {
          body: string
          club_id: string
          created_at?: string
          id?: string
          is_read?: boolean
          kind: string
          metadata?: Json | null
          user_id: string
        }
        Update: {
          body?: string
          club_id?: string
          created_at?: string
          id?: string
          is_read?: boolean
          kind?: string
          metadata?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      operating_hours: {
        Row: {
          closes_at: string
          club_id: string
          created_at: string
          day_of_week: number
          id: string
          is_closed: boolean
          opens_at: string
          updated_at: string
        }
        Insert: {
          closes_at: string
          club_id: string
          created_at?: string
          day_of_week: number
          id?: string
          is_closed?: boolean
          opens_at: string
          updated_at?: string
        }
        Update: {
          closes_at?: string
          club_id?: string
          created_at?: string
          day_of_week?: number
          id?: string
          is_closed?: boolean
          opens_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operating_hours_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      operating_hours_override: {
        Row: {
          closes_at: string | null
          club_id: string
          created_at: string
          id: string
          is_closed: boolean
          note: string | null
          opens_at: string | null
          override_date: string
          updated_at: string
        }
        Insert: {
          closes_at?: string | null
          club_id: string
          created_at?: string
          id?: string
          is_closed?: boolean
          note?: string | null
          opens_at?: string | null
          override_date: string
          updated_at?: string
        }
        Update: {
          closes_at?: string | null
          club_id?: string
          created_at?: string
          id?: string
          is_closed?: boolean
          note?: string | null
          opens_at?: string | null
          override_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operating_hours_override_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_checkout_attempts: {
        Row: {
          amount_expected_cents: number
          club_id: string
          created_at: string
          created_by: string | null
          currency_expected: string
          id: string
          livemode: boolean
          payment_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          stripe_session_expires_at: string | null
          updated_at: string
        }
        Insert: {
          amount_expected_cents: number
          club_id: string
          created_at?: string
          created_by?: string | null
          currency_expected: string
          id?: string
          livemode: boolean
          payment_id: string
          status?: string
          stripe_account_id: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_session_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          amount_expected_cents?: number
          club_id?: string
          created_at?: string
          created_by?: string | null
          currency_expected?: string
          id?: string
          livemode?: boolean
          payment_id?: string
          status?: string
          stripe_account_id?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_session_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_checkout_attempts_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_checkout_attempts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_checkout_attempts_payment_id_club_id_fkey"
            columns: ["payment_id", "club_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "club_id"]
          },
        ]
      }
      payment_disputes: {
        Row: {
          amount_cents: number
          club_id: string
          created_at: string
          currency: string
          evidence_due_by: string | null
          id: string
          is_charge_refundable: boolean
          last_synced_at: string
          livemode: boolean
          payment_id: string
          reason: string
          source_checkout_attempt_id: string
          status: string
          stripe_account_id: string
          stripe_charge_id: string
          stripe_created_at: string
          stripe_dispute_id: string
          stripe_payment_intent_id: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          club_id: string
          created_at?: string
          currency: string
          evidence_due_by?: string | null
          id?: string
          is_charge_refundable: boolean
          last_synced_at?: string
          livemode: boolean
          payment_id: string
          reason: string
          source_checkout_attempt_id: string
          status: string
          stripe_account_id: string
          stripe_charge_id: string
          stripe_created_at: string
          stripe_dispute_id: string
          stripe_payment_intent_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          club_id?: string
          created_at?: string
          currency?: string
          evidence_due_by?: string | null
          id?: string
          is_charge_refundable?: boolean
          last_synced_at?: string
          livemode?: boolean
          payment_id?: string
          reason?: string
          source_checkout_attempt_id?: string
          status?: string
          stripe_account_id?: string
          stripe_charge_id?: string
          stripe_created_at?: string
          stripe_dispute_id?: string
          stripe_payment_intent_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_disputes_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_disputes_payment_id_club_id_fkey"
            columns: ["payment_id", "club_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "club_id"]
          },
          {
            foreignKeyName: "payment_disputes_source_checkout_attempt_id_fkey"
            columns: ["source_checkout_attempt_id"]
            isOneToOne: false
            referencedRelation: "payment_checkout_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_events: {
        Row: {
          actor_id: string | null
          amount_cents: number | null
          club_id: string
          created_at: string
          event_type: string
          external_reference: string | null
          id: string
          method: string | null
          notes: string | null
          occurred_at: string
          payment_id: string
          reverses_event_id: string | null
        }
        Insert: {
          actor_id?: string | null
          amount_cents?: number | null
          club_id: string
          created_at?: string
          event_type: string
          external_reference?: string | null
          id?: string
          method?: string | null
          notes?: string | null
          occurred_at?: string
          payment_id: string
          reverses_event_id?: string | null
        }
        Update: {
          actor_id?: string | null
          amount_cents?: number | null
          club_id?: string
          created_at?: string
          event_type?: string
          external_reference?: string | null
          id?: string
          method?: string | null
          notes?: string | null
          occurred_at?: string
          payment_id?: string
          reverses_event_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_events_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_events_payment_id_club_id_fkey"
            columns: ["payment_id", "club_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "club_id"]
          },
          {
            foreignKeyName: "payment_events_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_events_reverses_event_id_fkey"
            columns: ["reverses_event_id"]
            isOneToOne: false
            referencedRelation: "payment_events"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_refund_attempts: {
        Row: {
          admin_reason: string | null
          club_id: string
          created_at: string
          created_by: string | null
          failure_reason: string | null
          id: string
          initiated_via: string
          livemode: boolean
          payment_id: string
          requested_amount_cents: number
          source_checkout_attempt_id: string
          status: string
          stripe_account_id: string
          stripe_payment_intent_id: string | null
          stripe_refund_id: string | null
          updated_at: string
        }
        Insert: {
          admin_reason?: string | null
          club_id: string
          created_at?: string
          created_by?: string | null
          failure_reason?: string | null
          id?: string
          initiated_via?: string
          livemode: boolean
          payment_id: string
          requested_amount_cents: number
          source_checkout_attempt_id: string
          status?: string
          stripe_account_id: string
          stripe_payment_intent_id?: string | null
          stripe_refund_id?: string | null
          updated_at?: string
        }
        Update: {
          admin_reason?: string | null
          club_id?: string
          created_at?: string
          created_by?: string | null
          failure_reason?: string | null
          id?: string
          initiated_via?: string
          livemode?: boolean
          payment_id?: string
          requested_amount_cents?: number
          source_checkout_attempt_id?: string
          status?: string
          stripe_account_id?: string
          stripe_payment_intent_id?: string | null
          stripe_refund_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_refund_attempts_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_refund_attempts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_refund_attempts_payment_id_club_id_fkey"
            columns: ["payment_id", "club_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "club_id"]
          },
          {
            foreignKeyName: "payment_refund_attempts_source_checkout_attempt_id_fkey"
            columns: ["source_checkout_attempt_id"]
            isOneToOne: false
            referencedRelation: "payment_checkout_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_refund_requests: {
        Row: {
          beneficiary_user_id: string | null
          club_id: string
          created_at: string
          id: string
          notes: string | null
          payment_id: string
          policy_refundable_cents_at_cancellation: number | null
          reason: string
          refund_attempt_id: string | null
          rejection_reason: string | null
          requested_amount_cents: number
          requested_by: string
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          beneficiary_user_id?: string | null
          club_id: string
          created_at?: string
          id?: string
          notes?: string | null
          payment_id: string
          policy_refundable_cents_at_cancellation?: number | null
          reason: string
          refund_attempt_id?: string | null
          rejection_reason?: string | null
          requested_amount_cents: number
          requested_by: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          beneficiary_user_id?: string | null
          club_id?: string
          created_at?: string
          id?: string
          notes?: string | null
          payment_id?: string
          policy_refundable_cents_at_cancellation?: number | null
          reason?: string
          refund_attempt_id?: string | null
          rejection_reason?: string | null
          requested_amount_cents?: number
          requested_by?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_refund_requests_beneficiary_user_id_fkey"
            columns: ["beneficiary_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_refund_requests_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_refund_requests_payment_id_club_id_fkey"
            columns: ["payment_id", "club_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "club_id"]
          },
          {
            foreignKeyName: "payment_refund_requests_refund_attempt_id_fkey"
            columns: ["refund_attempt_id"]
            isOneToOne: false
            referencedRelation: "payment_refund_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_refund_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_refund_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_due_cents: number
          amount_paid_cents: number
          club_id: string
          created_at: string
          created_by: string | null
          currency: string
          domain_id: string
          domain_type: string
          id: string
          obligation_cycle: number
          payment_mode_at_creation: string
          roster_member_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount_due_cents?: number
          amount_paid_cents?: number
          club_id: string
          created_at?: string
          created_by?: string | null
          currency: string
          domain_id: string
          domain_type: string
          id?: string
          obligation_cycle: number
          payment_mode_at_creation: string
          roster_member_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount_due_cents?: number
          amount_paid_cents?: number
          club_id?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          domain_id?: string
          domain_type?: string
          id?: string
          obligation_cycle?: number
          payment_mode_at_creation?: string
          roster_member_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_roster_member_id_fkey"
            columns: ["roster_member_id"]
            isOneToOne: false
            referencedRelation: "roster_members"
            referencedColumns: ["id"]
          },
        ]
      }
      pilot_inquiries: {
        Row: {
          additional_details: string | null
          approximate_member_count: number
          club_name: string
          contact_name: string
          court_count: number
          created_at: string
          current_process: string
          email: string
          facility_type: string
          facility_type_other: string | null
          id: string
          operational_challenge: string
          phone: string | null
          preferred_contact_method: string | null
          preferred_operating_model: string
          request_fingerprint: string | null
          source: string
          status: string
          updated_at: string
          website: string | null
        }
        Insert: {
          additional_details?: string | null
          approximate_member_count: number
          club_name: string
          contact_name: string
          court_count: number
          created_at?: string
          current_process: string
          email: string
          facility_type: string
          facility_type_other?: string | null
          id?: string
          operational_challenge: string
          phone?: string | null
          preferred_contact_method?: string | null
          preferred_operating_model: string
          request_fingerprint?: string | null
          source?: string
          status?: string
          updated_at?: string
          website?: string | null
        }
        Update: {
          additional_details?: string | null
          approximate_member_count?: number
          club_name?: string
          contact_name?: string
          court_count?: number
          created_at?: string
          current_process?: string
          email?: string
          facility_type?: string
          facility_type_other?: string | null
          id?: string
          operational_challenge?: string
          phone?: string | null
          preferred_contact_method?: string | null
          preferred_operating_model?: string
          request_fingerprint?: string | null
          source?: string
          status?: string
          updated_at?: string
          website?: string | null
        }
        Relationships: []
      }
      pro_availability_windows: {
        Row: {
          club_id: string
          created_at: string
          day_of_week: number
          end_time: string
          id: string
          is_active: boolean
          pro_id: string
          start_time: string
          updated_at: string
        }
        Insert: {
          club_id: string
          created_at?: string
          day_of_week: number
          end_time: string
          id?: string
          is_active?: boolean
          pro_id: string
          start_time: string
          updated_at?: string
        }
        Update: {
          club_id?: string
          created_at?: string
          day_of_week?: number
          end_time?: string
          id?: string
          is_active?: boolean
          pro_id?: string
          start_time?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pro_availability_windows_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pro_availability_windows_pro_id_fkey"
            columns: ["pro_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pro_blackout_dates: {
        Row: {
          blackout_date: string
          club_id: string
          created_at: string
          id: string
          pro_id: string
          reason: string | null
        }
        Insert: {
          blackout_date: string
          club_id: string
          created_at?: string
          id?: string
          pro_id: string
          reason?: string | null
        }
        Update: {
          blackout_date?: string
          club_id?: string
          created_at?: string
          id?: string
          pro_id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pro_blackout_dates_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pro_blackout_dates_pro_id_fkey"
            columns: ["pro_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active_club_id: string | null
          admin_notes: string | null
          club_id: string | null
          created_at: string
          first_name: string | null
          id: string
          is_lesson_provider: boolean
          last_name: string | null
          phone: string | null
          role: string
          sms_opt_in: boolean
          sms_opted_in_at: string | null
          sms_opted_in_ip: string | null
          status: string
          updated_at: string
        }
        Insert: {
          active_club_id?: string | null
          admin_notes?: string | null
          club_id?: string | null
          created_at?: string
          first_name?: string | null
          id: string
          is_lesson_provider?: boolean
          last_name?: string | null
          phone?: string | null
          role?: string
          sms_opt_in?: boolean
          sms_opted_in_at?: string | null
          sms_opted_in_ip?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          active_club_id?: string | null
          admin_notes?: string | null
          club_id?: string | null
          created_at?: string
          first_name?: string | null
          id?: string
          is_lesson_provider?: boolean
          last_name?: string | null
          phone?: string | null
          role?: string
          sms_opt_in?: boolean
          sms_opted_in_at?: string | null
          sms_opted_in_ip?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_active_club_id_fkey"
            columns: ["active_club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      program_enrollments: {
        Row: {
          created_at: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          offer_expires_at?: string | null
          price_amount_cents?: number | null
          profile_id?: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at?: string
          waitlisted_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          offer_expires_at?: string | null
          price_amount_cents?: number | null
          profile_id?: string | null
          program_id?: string
          roster_member_id?: string
          status?: string
          updated_at?: string
          waitlisted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "program_enrollments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "program_enrollments_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "program_enrollments_roster_member_id_fkey"
            columns: ["roster_member_id"]
            isOneToOne: false
            referencedRelation: "roster_members"
            referencedColumns: ["id"]
          },
        ]
      }
      program_rule_courts: {
        Row: {
          court_id: string
          created_at: string
          id: string
          program_schedule_rule_id: string
        }
        Insert: {
          court_id: string
          created_at?: string
          id?: string
          program_schedule_rule_id: string
        }
        Update: {
          court_id?: string
          created_at?: string
          id?: string
          program_schedule_rule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "program_rule_courts_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "program_rule_courts_program_schedule_rule_id_fkey"
            columns: ["program_schedule_rule_id"]
            isOneToOne: false
            referencedRelation: "program_schedule_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      program_schedule_rules: {
        Row: {
          capacity_override: number | null
          created_at: string
          day_of_week: number
          duration_minutes: number
          id: string
          program_id: string
          start_time: string
          updated_at: string
        }
        Insert: {
          capacity_override?: number | null
          created_at?: string
          day_of_week: number
          duration_minutes: number
          id?: string
          program_id: string
          start_time: string
          updated_at?: string
        }
        Update: {
          capacity_override?: number | null
          created_at?: string
          day_of_week?: number
          duration_minutes?: number
          id?: string
          program_id?: string
          start_time?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "program_schedule_rules_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "programs"
            referencedColumns: ["id"]
          },
        ]
      }
      programs: {
        Row: {
          archived_at: string | null
          archived_by: string | null
          club_id: string
          created_at: string
          created_by: string
          default_capacity: number
          description: string | null
          ends_on: string
          enrollment_model: string
          event_type_id: string
          id: string
          price_amount_cents: number | null
          starts_on: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          archived_by?: string | null
          club_id: string
          created_at?: string
          created_by: string
          default_capacity: number
          description?: string | null
          ends_on: string
          enrollment_model: string
          event_type_id: string
          id?: string
          price_amount_cents?: number | null
          starts_on: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          archived_by?: string | null
          club_id?: string
          created_at?: string
          created_by?: string
          default_capacity?: number
          description?: string | null
          ends_on?: string
          enrollment_model?: string
          event_type_id?: string
          id?: string
          price_amount_cents?: number | null
          starts_on?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "programs_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "programs_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "programs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "programs_event_type_id_fkey"
            columns: ["event_type_id"]
            isOneToOne: false
            referencedRelation: "event_types"
            referencedColumns: ["id"]
          },
        ]
      }
      reservation_guests: {
        Row: {
          added_by: string
          created_at: string
          display_name: string
          id: string
          removed_at: string | null
          removed_by: string | null
          reservation_id: string
          status: string
          updated_at: string
        }
        Insert: {
          added_by: string
          created_at?: string
          display_name: string
          id?: string
          removed_at?: string | null
          removed_by?: string | null
          reservation_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          added_by?: string
          created_at?: string
          display_name?: string
          id?: string
          removed_at?: string | null
          removed_by?: string | null
          reservation_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservation_guests_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_guests_removed_by_fkey"
            columns: ["removed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_guests_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      reservation_participants: {
        Row: {
          added_by: string
          created_at: string
          id: string
          removed_at: string | null
          removed_by: string | null
          reservation_id: string
          roster_member_id: string
          status: string
          updated_at: string
        }
        Insert: {
          added_by: string
          created_at?: string
          id?: string
          removed_at?: string | null
          removed_by?: string | null
          reservation_id: string
          roster_member_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          added_by?: string
          created_at?: string
          id?: string
          removed_at?: string | null
          removed_by?: string | null
          reservation_id?: string
          roster_member_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservation_participants_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_participants_removed_by_fkey"
            columns: ["removed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_participants_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_participants_roster_member_id_fkey"
            columns: ["roster_member_id"]
            isOneToOne: false
            referencedRelation: "roster_members"
            referencedColumns: ["id"]
          },
        ]
      }
      reservation_player_searches: {
        Row: {
          created_at: string
          created_by: string
          host_roster_member_id: string
          id: string
          is_open: boolean
          player_capacity: number
          reservation_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          host_roster_member_id: string
          id?: string
          is_open?: boolean
          player_capacity: number
          reservation_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          host_roster_member_id?: string
          id?: string
          is_open?: boolean
          player_capacity?: number
          reservation_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservation_player_searches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_player_searches_host_roster_member_id_fkey"
            columns: ["host_roster_member_id"]
            isOneToOne: false
            referencedRelation: "roster_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_player_searches_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: true
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      reservations: {
        Row: {
          cancellation_kind: string | null
          cancellation_policy_state: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          court_id: string
          created_at: string
          created_by: string
          ends_at: string
          event_id: string | null
          format: string | null
          guest_names: string[] | null
          hourly_rate_cents: number | null
          id: string
          membership_pricing_class: string | null
          notes: string | null
          owner_user_id: string | null
          player_count: number | null
          price_amount_cents: number | null
          reason: string
          roster_member_id: string | null
          show_notes_to_members: boolean
          starts_at: string
          status: string
          updated_at: string
        }
        Insert: {
          cancellation_kind?: string | null
          cancellation_policy_state?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          club_id: string
          court_id: string
          created_at?: string
          created_by: string
          ends_at: string
          event_id?: string | null
          format?: string | null
          guest_names?: string[] | null
          hourly_rate_cents?: number | null
          id?: string
          membership_pricing_class?: string | null
          notes?: string | null
          owner_user_id?: string | null
          player_count?: number | null
          price_amount_cents?: number | null
          reason?: string
          roster_member_id?: string | null
          show_notes_to_members?: boolean
          starts_at: string
          status?: string
          updated_at?: string
        }
        Update: {
          cancellation_kind?: string | null
          cancellation_policy_state?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          club_id?: string
          court_id?: string
          created_at?: string
          created_by?: string
          ends_at?: string
          event_id?: string | null
          format?: string | null
          guest_names?: string[] | null
          hourly_rate_cents?: number | null
          id?: string
          membership_pricing_class?: string | null
          notes?: string | null
          owner_user_id?: string | null
          player_count?: number | null
          price_amount_cents?: number | null
          reason?: string
          roster_member_id?: string | null
          show_notes_to_members?: boolean
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservations_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_roster_member_id_fkey"
            columns: ["roster_member_id"]
            isOneToOne: false
            referencedRelation: "roster_members"
            referencedColumns: ["id"]
          },
        ]
      }
      roster_members: {
        Row: {
          claimed_by: string | null
          club_id: string
          created_at: string
          created_by: string
          email: string | null
          first_name: string
          id: string
          last_name: string
          membership_status: string
          membership_type_id: string | null
          notes: string | null
          phone: string | null
          removed_at: string | null
          removed_by: string | null
          role: string
          status: string
          updated_at: string
        }
        Insert: {
          claimed_by?: string | null
          club_id: string
          created_at?: string
          created_by: string
          email?: string | null
          first_name: string
          id?: string
          last_name: string
          membership_status?: string
          membership_type_id?: string | null
          notes?: string | null
          phone?: string | null
          removed_at?: string | null
          removed_by?: string | null
          role?: string
          status?: string
          updated_at?: string
        }
        Update: {
          claimed_by?: string | null
          club_id?: string
          created_at?: string
          created_by?: string
          email?: string | null
          first_name?: string
          id?: string
          last_name?: string
          membership_status?: string
          membership_type_id?: string | null
          notes?: string | null
          phone?: string | null
          removed_at?: string | null
          removed_by?: string | null
          role?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "roster_members_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_members_membership_type_club_fkey"
            columns: ["membership_type_id", "club_id"]
            isOneToOne: false
            referencedRelation: "membership_types"
            referencedColumns: ["id", "club_id"]
          },
          {
            foreignKeyName: "roster_members_removed_by_fkey"
            columns: ["removed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_event_receipts: {
        Row: {
          created_at: string
          event_type: string
          livemode: boolean
          processed_at: string
          stripe_account_id: string
          stripe_event_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          livemode: boolean
          processed_at?: string
          stripe_account_id: string
          stripe_event_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          livemode?: boolean
          processed_at?: string
          stripe_account_id?: string
          stripe_event_id?: string
        }
        Relationships: []
      }
      v_profile: {
        Row: {
          admin_notes: string | null
          club_id: string | null
          created_at: string | null
          first_name: string | null
          id: string | null
          is_lesson_provider: boolean | null
          last_name: string | null
          phone: string | null
          role: string | null
          sms_opt_in: boolean | null
          sms_opted_in_at: string | null
          sms_opted_in_ip: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          admin_notes?: string | null
          club_id?: string | null
          created_at?: string | null
          first_name?: string | null
          id?: string | null
          is_lesson_provider?: boolean | null
          last_name?: string | null
          phone?: string | null
          role?: string | null
          sms_opt_in?: boolean | null
          sms_opted_in_at?: string | null
          sms_opted_in_ip?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          admin_notes?: string | null
          club_id?: string | null
          created_at?: string | null
          first_name?: string | null
          id?: string | null
          is_lesson_provider?: boolean | null
          last_name?: string | null
          phone?: string | null
          role?: string | null
          sms_opt_in?: boolean | null
          sms_opted_in_at?: string | null
          sms_opted_in_ip?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      waiver_acceptances: {
        Row: {
          accepted_at: string
          accepted_by: string
          club_id: string
          id: string
          roster_member_id: string
          waiver_version_id: string
        }
        Insert: {
          accepted_at?: string
          accepted_by: string
          club_id: string
          id?: string
          roster_member_id: string
          waiver_version_id: string
        }
        Update: {
          accepted_at?: string
          accepted_by?: string
          club_id?: string
          id?: string
          roster_member_id?: string
          waiver_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_acceptances_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_acceptances_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_acceptances_roster_member_id_fkey"
            columns: ["roster_member_id"]
            isOneToOne: false
            referencedRelation: "roster_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_acceptances_waiver_version_id_fkey"
            columns: ["waiver_version_id"]
            isOneToOne: false
            referencedRelation: "waiver_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      waiver_document_files: {
        Row: {
          file_size_bytes: number
          mime_type: string
          original_filename: string
          sha256_digest: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string
          waiver_version_id: string
        }
        Insert: {
          file_size_bytes: number
          mime_type: string
          original_filename: string
          sha256_digest: string
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
          waiver_version_id: string
        }
        Update: {
          file_size_bytes?: number
          mime_type?: string
          original_filename?: string
          sha256_digest?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
          waiver_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_document_files_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_document_files_waiver_version_id_fkey"
            columns: ["waiver_version_id"]
            isOneToOne: true
            referencedRelation: "waiver_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      waiver_versions: {
        Row: {
          body: string | null
          created_at: string
          id: string
          published_at: string | null
          published_by: string | null
          status: string
          title: string
          updated_at: string
          version_number: number
          waiver_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          published_at?: string | null
          published_by?: string | null
          status?: string
          title: string
          updated_at?: string
          version_number: number
          waiver_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          published_at?: string | null
          published_by?: string | null
          status?: string
          title?: string
          updated_at?: string
          version_number?: number
          waiver_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_versions_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_versions_waiver_id_fkey"
            columns: ["waiver_id"]
            isOneToOne: false
            referencedRelation: "waivers"
            referencedColumns: ["id"]
          },
        ]
      }
      waivers: {
        Row: {
          audience: string
          club_id: string
          created_at: string
          current_version_id: string | null
          id: string
          is_required: boolean
          updated_at: string
        }
        Insert: {
          audience?: string
          club_id: string
          created_at?: string
          current_version_id?: string | null
          id?: string
          is_required?: boolean
          updated_at?: string
        }
        Update: {
          audience?: string
          club_id?: string
          created_at?: string
          current_version_id?: string | null
          id?: string
          is_required?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "waivers_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waivers_current_version_id_fkey"
            columns: ["current_version_id", "id"]
            isOneToOne: false
            referencedRelation: "waiver_versions"
            referencedColumns: ["id", "waiver_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _adjust_payment_obligation: {
        Args: {
          p_actor_id: string
          p_club_id: string
          p_domain_id: string
          p_domain_type: string
          p_new_amount_cents: number
          p_roster_member_id: string
        }
        Returns: undefined
      }
      _advance_program_waitlist_offer: {
        Args: {
          p_club_id: string
          p_program_id: string
          p_program_title: string
        }
        Returns: string
      }
      _announcement_recipient_candidates: {
        Args: {
          p_club_id: string
          p_exclude_user_id: string
          p_recipient_user_ids?: string[]
        }
        Returns: {
          announcement_enabled: boolean
          user_id: string
        }[]
      }
      _assert_event_capacity_available: {
        Args: {
          p_additional?: number
          p_event_id: string
          p_exclude_event_guest_id?: string
          p_exclude_event_participant_id?: string
          p_exclude_roster_member_id?: string
        }
        Returns: undefined
      }
      _assert_roster_member_schedule_available: {
        Args: {
          p_ends_at: string
          p_exclude_event_participant_id?: string
          p_exclude_lesson_request_id?: string
          p_exclude_reservation_id?: string
          p_roster_member_id: string
          p_starts_at: string
        }
        Returns: undefined
      }
      _authorize_reservation_roster_access: {
        Args: {
          p_expected_club_id: string
          p_require_not_cancelled: boolean
          p_reservation_id: string
        }
        Returns: {
          cancellation_kind: string | null
          cancellation_policy_state: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          court_id: string
          created_at: string
          created_by: string
          ends_at: string
          event_id: string | null
          format: string | null
          guest_names: string[] | null
          hourly_rate_cents: number | null
          id: string
          membership_pricing_class: string | null
          notes: string | null
          owner_user_id: string | null
          player_count: number | null
          price_amount_cents: number | null
          reason: string
          roster_member_id: string | null
          show_notes_to_members: boolean
          starts_at: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "reservations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      _cancel_program_member_future_participation: {
        Args: {
          p_club_id: string
          p_program_id: string
          p_roster_member_id: string
        }
        Returns: undefined
      }
      _check_member_reassignment_allowed: {
        Args: { p_club_id: string; p_domain_id: string; p_domain_type: string }
        Returns: undefined
      }
      _close_prior_member_waiver_notifications: {
        Args: { p_current_version_id: string; p_waiver_id: string }
        Returns: undefined
      }
      _complete_refund_request_for_attempt: {
        Args: { p_refund_attempt_id: string }
        Returns: undefined
      }
      _compute_online_refundable_amounts: {
        Args: { p_club_id: string; p_payment_ids: string[] }
        Returns: {
          currency: string
          payment_id: string
          refundable_cents: number
        }[]
      }
      _create_payment_obligation: {
        Args: {
          p_actor_id: string
          p_amount_cents: number
          p_club_id: string
          p_domain_id: string
          p_domain_type: string
          p_new_cycle?: boolean
          p_roster_member_id: string
        }
        Returns: string
      }
      _current_user_active_membership: {
        Args: never
        Returns: {
          club_id: string
          is_lesson_provider: boolean
          role: string
          status: string
        }[]
      }
      _ensure_policy_cancellation_refund_request: {
        Args: {
          p_actor_id: string
          p_club_id: string
          p_payment_id: string
          p_policy_state: string
        }
        Returns: string
      }
      _evaluate_cancellation_policy: {
        Args: {
          p_evaluated_at: string
          p_grace_anchor: string
          p_grace_minutes: number
          p_starts_at: string
          p_window_hours: number
        }
        Returns: {
          cutoff_at: string
          state: string
          within_grace: boolean
        }[]
      }
      _evaluate_member_waiver_status: {
        Args: { p_club_id: string; p_roster_member_id: string }
        Returns: string
      }
      _event_effective_occupancy: {
        Args: {
          p_event_id: string
          p_exclude_event_guest_id?: string
          p_exclude_event_participant_id?: string
          p_exclude_roster_member_id?: string
        }
        Returns: number
      }
      _expire_stale_program_offers: {
        Args: {
          p_club_id: string
          p_program_id: string
          p_program_title: string
        }
        Returns: undefined
      }
      _invalidate_or_flag_open_checkout_attempt: {
        Args: { p_payment_id: string }
        Returns: undefined
      }
      _is_active_member_of_club: {
        Args: { p_club_id: string; p_profile_id: string; p_role: string }
        Returns: boolean
      }
      _leave_event_impl: { Args: { p_event_id: string }; Returns: Json }
      _lesson_check_member_availability: {
        Args: {
          p_ends_at: string
          p_exclude_request_id?: string
          p_member_id: string
          p_roster_member_id: string
          p_starts_at: string
        }
        Returns: undefined
      }
      _lesson_check_operating_hours: {
        Args: {
          p_club_id: string
          p_ends_at: string
          p_starts_at: string
          p_tz: string
        }
        Returns: undefined
      }
      _lesson_check_pro_availability: {
        Args: {
          p_ends_at: string
          p_exclude_request_id?: string
          p_pro_id: string
          p_starts_at: string
        }
        Returns: undefined
      }
      _lesson_check_pro_availability_for_club: {
        Args: {
          p_club_id: string
          p_ends_at: string
          p_exclude_request_id?: string
          p_pro_id: string
          p_starts_at: string
        }
        Returns: undefined
      }
      _lock_and_validate_reservation_roster_mutable: {
        Args: { p_reservation_id: string }
        Returns: {
          cancellation_kind: string | null
          cancellation_policy_state: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          court_id: string
          created_at: string
          created_by: string
          ends_at: string
          event_id: string | null
          format: string | null
          guest_names: string[] | null
          hourly_rate_cents: number | null
          id: string
          membership_pricing_class: string | null
          notes: string | null
          owner_user_id: string | null
          player_count: number | null
          price_amount_cents: number | null
          reason: string
          roster_member_id: string | null
          show_notes_to_members: boolean
          starts_at: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "reservations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      _lock_reservation_player_search_row: {
        Args: { p_reservation_id: string }
        Returns: {
          created_at: string
          created_by: string
          host_roster_member_id: string
          id: string
          is_open: boolean
          player_capacity: number
          reservation_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "reservation_player_searches"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      _lock_reservation_player_search_scope: {
        Args: { p_reservation_id: string }
        Returns: undefined
      }
      _materialize_program_member_into_future_events: {
        Args: {
          p_club_id: string
          p_program_id: string
          p_roster_member_id: string
        }
        Returns: undefined
      }
      _mint_guest_waiver_invitation: {
        Args: {
          p_actor_user_id: string
          p_club_id: string
          p_event_guest_id: string
          p_reservation_guest_id: string
          p_token_hash: string
        }
        Returns: string
      }
      _notify_member_waiver_requires_acceptance: {
        Args: { p_club_id: string; p_waiver_version_id: string }
        Returns: undefined
      }
      _program_candidate_fits_future_sessions: {
        Args: { p_program_id: string; p_roster_member_id: string }
        Returns: boolean
      }
      _program_is_enrollable: {
        Args: { p_program: Database["public"]["Tables"]["programs"]["Row"] }
        Returns: boolean
      }
      _recompute_payment_rollup: {
        Args: { p_payment_id: string }
        Returns: undefined
      }
      _reconcile_stripe_refund_attempt: {
        Args: {
          p_amount_cents: number
          p_currency: string
          p_failure_reason?: string
          p_livemode: boolean
          p_refund_attempt_id: string
          p_status: string
          p_stripe_account_id: string
          p_stripe_payment_intent_id?: string
          p_stripe_refund_id: string
        }
        Returns: undefined
      }
      _release_uncollected_cancellation_balance: {
        Args: { p_actor_id: string; p_club_id: string; p_payment_id: string }
        Returns: undefined
      }
      _reporting_daily_open_hours: {
        Args: { p_club_id: string; p_end_date: string; p_start_date: string }
        Returns: number
      }
      _reporting_reserved_hours: {
        Args: { p_club_id: string; p_range: unknown }
        Returns: {
          court_id: string
          hours: number
          reason: string
        }[]
      }
      _reservation_player_search_block_reason: {
        Args: {
          p_reservation: Database["public"]["Tables"]["reservations"]["Row"]
          p_search: Database["public"]["Tables"]["reservation_player_searches"]["Row"]
        }
        Returns: string
      }
      _reservation_player_search_is_effective_open: {
        Args: {
          p_reservation: Database["public"]["Tables"]["reservations"]["Row"]
          p_search: Database["public"]["Tables"]["reservation_player_searches"]["Row"]
        }
        Returns: boolean
      }
      _reservation_player_search_occupied_seats: {
        Args: { p_host_roster_member_id: string; p_reservation_id: string }
        Returns: number
      }
      _resolve_court_reservation_rate: {
        Args: {
          p_club_id: string
          p_court_id: string
          p_membership_pricing_class: string
          p_starts_at: string
        }
        Returns: {
          applied_rate_period_id: string
          applied_rate_period_name: string
          applied_rate_source: string
          hourly_rate_cents: number
        }[]
      }
      _resolve_or_import_refund_attempt_by_provenance: {
        Args: {
          p_amount_cents: number
          p_livemode: boolean
          p_stripe_account_id: string
          p_stripe_payment_intent_id: string
          p_stripe_refund_id: string
        }
        Returns: string
      }
      _roster_member_id_for: {
        Args: { p_club_id: string; p_profile_id: string }
        Returns: string
      }
      _validate_program_definition: {
        Args: {
          p_club_id: string
          p_event_type_id: string
          p_program_id: string
        }
        Returns: undefined
      }
      accept_club_invite: { Args: { p_code: string }; Returns: Json }
      accept_guest_waiver: {
        Args: { p_token_hash: string; p_waiver_version_id: string }
        Returns: string
      }
      accept_lesson_proposal: { Args: { p_request_id: string }; Returns: Json }
      accept_member_waiver: {
        Args: { p_waiver_version_id: string }
        Returns: string
      }
      accept_program_waitlist_offer: {
        Args: { p_program_id: string }
        Returns: {
          created_at: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "program_enrollments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      accept_waitlist_offer: {
        Args: { p_event_id: string }
        Returns: {
          attendance_status: string | null
          cancelled_at: string | null
          confirmed_at: string | null
          created_at: string
          event_id: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          role: string
          roster_member_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "event_participants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      activate_court_time_payments: {
        Args: { p_actor_id: string; p_club_id: string; p_livemode: boolean }
        Returns: {
          booking_window_days: number
          cancellation_grace_minutes: number
          cancellation_window_hours: number
          club_id: string
          created_at: string
          currency: string
          default_court_hourly_rate_cents: number | null
          default_court_hourly_rate_non_member_cents: number | null
          id: string
          memberships_enabled: boolean
          payment_mode: string
          rules_and_policies: string | null
          updated_at: string
          waitlist_offer_window_hours: number
        }
        SetofOptions: {
          from: "*"
          to: "club_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      add_court: { Args: { p_name: string }; Returns: undefined }
      add_member_note: {
        Args: { p_body: string; p_member_id: string }
        Returns: Json
      }
      add_program_member: {
        Args: { p_profile_id: string; p_program_id: string }
        Returns: {
          created_at: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "program_enrollments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      add_program_roster_member: {
        Args: {
          p_expected_club_id: string
          p_program_id: string
          p_roster_member_id: string
        }
        Returns: {
          created_at: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "program_enrollments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      add_reservation_guest: {
        Args: {
          p_display_name: string
          p_expected_club_id: string
          p_reservation_id: string
        }
        Returns: string
      }
      add_reservation_participant: {
        Args: {
          p_expected_club_id: string
          p_reservation_id: string
          p_roster_member_id: string
        }
        Returns: string
      }
      add_roster_member: {
        Args: {
          p_email?: string
          p_first_name: string
          p_last_name: string
          p_notes?: string
          p_phone?: string
          p_role?: string
        }
        Returns: string
      }
      add_roster_member_and_invite: {
        Args: {
          p_email: string
          p_first_name: string
          p_last_name: string
          p_notes?: string
          p_phone?: string
          p_role?: string
        }
        Returns: Json
      }
      admin_add_guest: {
        Args: { p_display_name: string; p_event_id: string }
        Returns: {
          added_by: string
          attendance_status: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          display_name: string
          event_id: string
          id: string
          price_amount_cents: number | null
          roster_member_id: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "event_guests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_add_member: {
        Args: { p_event_id: string; p_profile_id: string }
        Returns: {
          attendance_status: string | null
          cancelled_at: string | null
          confirmed_at: string | null
          created_at: string
          event_id: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          role: string
          roster_member_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "event_participants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_add_roster_member_to_event: {
        Args: { p_event_id: string; p_roster_member_id: string }
        Returns: {
          added_by: string
          attendance_status: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          display_name: string
          event_id: string
          id: string
          price_amount_cents: number | null
          roster_member_id: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "event_guests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_add_roster_participant: {
        Args: {
          p_event_id: string
          p_expected_club_id: string
          p_roster_member_id: string
        }
        Returns: {
          attendance_status: string | null
          cancelled_at: string | null
          confirmed_at: string | null
          created_at: string
          event_id: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          role: string
          roster_member_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "event_participants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_cancel_reservation: {
        Args: { p_reservation_id: string }
        Returns: {
          cancellation_kind: string | null
          cancellation_policy_state: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          court_id: string
          created_at: string
          created_by: string
          ends_at: string
          event_id: string | null
          format: string | null
          guest_names: string[] | null
          hourly_rate_cents: number | null
          id: string
          membership_pricing_class: string | null
          notes: string | null
          owner_user_id: string | null
          player_count: number | null
          price_amount_cents: number | null
          reason: string
          roster_member_id: string | null
          show_notes_to_members: boolean
          starts_at: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "reservations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_cancel_reservation_v2: {
        Args: { p_reservation_id: string }
        Returns: Json
      }
      admin_create_member_lesson: {
        Args: {
          p_court_id: string
          p_ends_at: string
          p_expected_club_id: string
          p_lesson_type_id?: string
          p_member_note?: string
          p_pro_id: string
          p_roster_member_id: string
          p_starts_at: string
        }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_create_member_reservation: {
        Args: {
          p_court_id: string
          p_ends_at: string
          p_expected_club_id: string
          p_format?: string
          p_guest_names?: string[]
          p_notes?: string
          p_player_count?: number
          p_roster_member_id: string
          p_starts_at: string
        }
        Returns: {
          cancellation_kind: string | null
          cancellation_policy_state: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          court_id: string
          created_at: string
          created_by: string
          ends_at: string
          event_id: string | null
          format: string | null
          guest_names: string[] | null
          hourly_rate_cents: number | null
          id: string
          membership_pricing_class: string | null
          notes: string | null
          owner_user_id: string | null
          player_count: number | null
          price_amount_cents: number | null
          reason: string
          roster_member_id: string | null
          show_notes_to_members: boolean
          starts_at: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "reservations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_expire_offer: {
        Args: { p_event_id: string; p_profile_id: string }
        Returns: undefined
      }
      admin_expire_offer_roster_participant: {
        Args: {
          p_event_id: string
          p_expected_club_id: string
          p_roster_member_id: string
        }
        Returns: undefined
      }
      admin_force_confirm: {
        Args: { p_event_id: string; p_profile_id: string }
        Returns: Json
      }
      admin_force_confirm_roster_participant: {
        Args: {
          p_event_id: string
          p_expected_club_id: string
          p_roster_member_id: string
        }
        Returns: Json
      }
      admin_offer_spot: {
        Args: { p_event_id: string; p_profile_id: string }
        Returns: Json
      }
      admin_offer_spot_roster_participant: {
        Args: {
          p_event_id: string
          p_expected_club_id: string
          p_roster_member_id: string
        }
        Returns: Json
      }
      admin_reassign_confirmed_lesson_pro: {
        Args: {
          p_expected_updated_at: string
          p_new_pro_id: string
          p_request_id: string
        }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_remove_guest: {
        Args: { p_event_id: string; p_guest_id: string }
        Returns: undefined
      }
      admin_remove_participant: {
        Args: { p_event_id: string; p_profile_id: string }
        Returns: undefined
      }
      admin_remove_roster_participant: {
        Args: {
          p_event_id: string
          p_expected_club_id: string
          p_roster_member_id: string
        }
        Returns: {
          attendance_status: string | null
          cancelled_at: string | null
          confirmed_at: string | null
          created_at: string
          event_id: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          role: string
          roster_member_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "event_participants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_update_member_lesson: {
        Args: {
          p_court_id: string
          p_ends_at: string
          p_expected_club_id: string
          p_expected_updated_at: string
          p_lesson_type_id?: string
          p_member_note?: string
          p_pro_id: string
          p_request_id: string
          p_roster_member_id: string
          p_starts_at: string
        }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      advance_waitlist_offer: {
        Args: {
          p_actor_id?: string
          p_club_id: string
          p_event_id: string
          p_event_title: string
        }
        Returns: Json
      }
      archive_event: {
        Args: { p_event_id: string }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          cancelled_at: string | null
          capacity: number
          club_id: string
          court_count: number
          created_at: string
          created_by: string
          description: string | null
          ends_at: string
          event_type_id: string
          id: string
          is_program_exception: boolean
          member_joinable: boolean
          price_amount_cents: number | null
          program_id: string | null
          program_occurrence_date: string | null
          program_schedule_rule_id: string | null
          starts_at: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      archive_lesson_type: { Args: { p_type_id: string }; Returns: undefined }
      archive_member_note: { Args: { p_note_id: string }; Returns: undefined }
      archive_program: {
        Args: { p_program_id: string }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          club_id: string
          created_at: string
          created_by: string
          default_capacity: number
          description: string | null
          ends_on: string
          enrollment_model: string
          event_type_id: string
          id: string
          price_amount_cents: number | null
          starts_on: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "programs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      backfill_refund_attempt_payment_intent: {
        Args: {
          p_refund_attempt_id: string
          p_stripe_payment_intent_id: string
        }
        Returns: undefined
      }
      begin_refund_request_execution: {
        Args: { p_actor_id: string; p_club_id: string; p_request_id: string }
        Returns: {
          club_id: string
          currency: string
          id: string
          livemode: boolean
          payment_id: string
          requested_amount_cents: number
          source_checkout_attempt_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string
        }[]
      }
      bind_stripe_refund_result: {
        Args: {
          p_amount_cents: number
          p_currency: string
          p_failure_reason?: string
          p_livemode: boolean
          p_refund_attempt_id: string
          p_status: string
          p_stripe_account_id: string
          p_stripe_payment_intent_id?: string
          p_stripe_refund_id: string
        }
        Returns: undefined
      }
      bootstrap_new_club: {
        Args: {
          p_booking_window_days?: number
          p_cancellation_grace_minutes?: number
          p_cancellation_window_hours?: number
          p_closes_at?: string
          p_court_count: number
          p_court_names?: string[]
          p_name: string
          p_opens_at?: string
          p_operator_user_id: string
          p_slug: string
          p_timezone: string
        }
        Returns: Json
      }
      cancel_event: { Args: { p_event_id: string }; Returns: Json }
      cancel_lesson: {
        Args: { p_reason?: string; p_request_id: string }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cancel_member_lesson_confirmed: {
        Args: {
          p_expected_policy_state: string
          p_reason: string
          p_request_id: string
        }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cancel_member_reservation: {
        Args: { p_expected_club_id: string; p_reservation_id: string }
        Returns: Json
      }
      cancel_member_reservation_confirmed: {
        Args: {
          p_expected_club_id: string
          p_expected_policy_state: string
          p_reservation_id: string
        }
        Returns: Json
      }
      cancel_program: {
        Args: { p_program_id: string }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          club_id: string
          created_at: string
          created_by: string
          default_capacity: number
          description: string | null
          ends_on: string
          enrollment_model: string
          event_type_id: string
          id: string
          price_amount_cents: number | null
          starts_on: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "programs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      clear_reservation_player_search: {
        Args: { p_expected_club_id: string; p_reservation_id: string }
        Returns: string
      }
      club_has_capability: {
        Args: { p_capability: string; p_club_id: string }
        Returns: boolean
      }
      club_local_bounds: {
        Args: { p_club_id: string; p_end_date: string; p_start_date: string }
        Returns: unknown
      }
      complete_program: {
        Args: { p_program_id: string }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          club_id: string
          created_at: string
          created_by: string
          default_capacity: number
          description: string | null
          ends_on: string
          enrollment_model: string
          event_type_id: string
          id: string
          price_amount_cents: number | null
          starts_on: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "programs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_club_invite: {
        Args: {
          p_expires_at?: string
          p_role: string
          p_roster_member_id: string
        }
        Returns: string
      }
      create_event: {
        Args: {
          p_capacity?: number
          p_court_ids: string[]
          p_description?: string
          p_ends_at: string
          p_event_type_id: string
          p_member_joinable?: boolean
          p_notes?: string
          p_starts_at: string
          p_title: string
        }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          cancelled_at: string | null
          capacity: number
          club_id: string
          court_count: number
          created_at: string
          created_by: string
          description: string | null
          ends_at: string
          event_type_id: string
          id: string
          is_program_exception: boolean
          member_joinable: boolean
          price_amount_cents: number | null
          program_id: string | null
          program_occurrence_date: string | null
          program_schedule_rule_id: string | null
          starts_at: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_event_type: {
        Args: { p_color: string; p_label: string }
        Returns: {
          club_id: string
          color: string
          created_at: string
          default_capacity: number
          default_court_count: number
          default_duration_minutes: number
          default_price_amount_cents: number | null
          id: string
          is_active: boolean
          key: string
          label: string
          shows_participant_names: boolean
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "event_types"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_event_with_price_override: {
        Args: {
          p_capacity?: number
          p_court_ids: string[]
          p_description?: string
          p_ends_at: string
          p_event_type_id: string
          p_member_joinable?: boolean
          p_notes?: string
          p_price_amount_cents: number
          p_starts_at: string
          p_title: string
        }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          cancelled_at: string | null
          capacity: number
          club_id: string
          court_count: number
          created_at: string
          created_by: string
          description: string | null
          ends_at: string
          event_type_id: string
          id: string
          is_program_exception: boolean
          member_joinable: boolean
          price_amount_cents: number | null
          program_id: string | null
          program_occurrence_date: string | null
          program_schedule_rule_id: string | null
          starts_at: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_guest_waiver_draft: {
        Args: { p_body: string; p_title: string }
        Returns: string
      }
      create_maintenance_block: {
        Args: {
          p_court_id: string
          p_ends_at: string
          p_notes?: string
          p_starts_at: string
        }
        Returns: {
          cancellation_kind: string | null
          cancellation_policy_state: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          court_id: string
          created_at: string
          created_by: string
          ends_at: string
          event_id: string | null
          format: string | null
          guest_names: string[] | null
          hourly_rate_cents: number | null
          id: string
          membership_pricing_class: string | null
          notes: string | null
          owner_user_id: string | null
          player_count: number | null
          price_amount_cents: number | null
          reason: string
          roster_member_id: string | null
          show_notes_to_members: boolean
          starts_at: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "reservations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_maintenance_blocks:
        | {
            Args: {
              p_court_ids: string[]
              p_ends_at: string
              p_notes?: string
              p_starts_at: string
            }
            Returns: undefined
          }
        | {
            Args: {
              p_court_ids: string[]
              p_ends_at: string
              p_notes?: string
              p_show_notes_to_members?: boolean
              p_starts_at: string
            }
            Returns: undefined
          }
      create_member_waiver_draft: {
        Args: { p_body: string; p_title: string }
        Returns: string
      }
      create_membership_type: {
        Args: { p_name: string }
        Returns: {
          club_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "membership_types"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_program: {
        Args: {
          p_default_capacity: number
          p_description?: string
          p_ends_on: string
          p_enrollment_model: string
          p_event_type_id: string
          p_rules: Json
          p_starts_on: string
          p_title: string
        }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          club_id: string
          created_at: string
          created_by: string
          default_capacity: number
          description: string | null
          ends_on: string
          enrollment_model: string
          event_type_id: string
          id: string
          price_amount_cents: number | null
          starts_on: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "programs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_refund_request: {
        Args: {
          p_amount_cents: number
          p_notes?: string
          p_payment_id: string
          p_reason: string
        }
        Returns: {
          beneficiary_user_id: string | null
          club_id: string
          created_at: string
          id: string
          notes: string | null
          payment_id: string
          policy_refundable_cents_at_cancellation: number | null
          reason: string
          refund_attempt_id: string | null
          rejection_reason: string | null
          requested_amount_cents: number
          requested_by: string
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "payment_refund_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_reservation: {
        Args: {
          p_court_id: string
          p_ends_at: string
          p_format?: string
          p_guest_names?: string[]
          p_notes?: string
          p_player_count?: number
          p_starts_at: string
        }
        Returns: {
          cancellation_kind: string | null
          cancellation_policy_state: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          court_id: string
          created_at: string
          created_by: string
          ends_at: string
          event_id: string | null
          format: string | null
          guest_names: string[] | null
          hourly_rate_cents: number | null
          id: string
          membership_pricing_class: string | null
          notes: string | null
          owner_user_id: string | null
          player_count: number | null
          price_amount_cents: number | null
          reason: string
          roster_member_id: string | null
          show_notes_to_members: boolean
          starts_at: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "reservations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_club_has_capability: {
        Args: { p_capability: string }
        Returns: boolean
      }
      current_user_club_id: { Args: never; Returns: string }
      current_user_enrolled_in_program: {
        Args: { p_program_id: string }
        Returns: boolean
      }
      current_user_is_lesson_provider: { Args: never; Returns: boolean }
      current_user_is_operator: { Args: never; Returns: boolean }
      current_user_participates_in_event: {
        Args: { p_event_id: string }
        Returns: boolean
      }
      current_user_role: { Args: never; Returns: string }
      current_user_roster_member_id: { Args: never; Returns: string }
      decline_lesson_proposal: {
        Args: { p_request_id: string }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decline_lesson_request: {
        Args: { p_reason?: string; p_request_id: string }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decline_program_waitlist_offer: {
        Args: { p_program_id: string }
        Returns: {
          created_at: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "program_enrollments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decline_waitlist_offer: { Args: { p_event_id: string }; Returns: string }
      delete_court: { Args: { p_court_id: string }; Returns: undefined }
      delete_event_type: { Args: { p_id: string }; Returns: undefined }
      delete_operating_hours_override: {
        Args: { p_dry_run?: boolean; p_override_date: string }
        Returns: Json
      }
      delete_pro_availability_window: {
        Args: { p_window_id: string }
        Returns: undefined
      }
      delete_pro_blackout: {
        Args: { p_blackout_id: string }
        Returns: undefined
      }
      delete_roster_member: { Args: { p_id: string }; Returns: undefined }
      discard_waiver_draft: {
        Args: { p_version_id: string }
        Returns: undefined
      }
      email_already_delivered: {
        Args: { p_notification_id: string }
        Returns: boolean
      }
      expire_blocking_checkout_attempt: {
        Args: { p_attempt_id: string; p_club_id: string; p_payment_id: string }
        Returns: {
          action: string
        }[]
      }
      expire_stale_offers_for_event: {
        Args: {
          p_actor_id?: string
          p_club_id: string
          p_event_id: string
          p_event_title: string
        }
        Returns: Json
      }
      force_confirm_program_roster_member: {
        Args: {
          p_expected_club_id: string
          p_program_id: string
          p_roster_member_id: string
        }
        Returns: {
          created_at: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "program_enrollments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      generate_program_sessions: {
        Args: {
          p_from_date?: string
          p_program_id: string
          p_through_date?: string
        }
        Returns: {
          event_ids: string[]
          inserted_count: number
          skipped_count: number
        }[]
      }
      get_admin_club_pros: {
        Args: never
        Returns: {
          first_name: string
          id: string
          is_lesson_provider: boolean
          last_name: string
          role: string
        }[]
      }
      get_admin_member_detail: {
        Args: { p_member_id: string }
        Returns: {
          attended_event_count: number
          completed_lesson_count: number
          created_at: string
          email: string
          event_no_show_count: number
          first_name: string
          id: string
          is_lesson_provider: boolean
          last_name: string
          member_lesson_no_show_count: number
          membership_status: string
          membership_type_id: string
          membership_type_name: string
          phone: string
          removed_at: string
          role: string
          status: string
        }[]
      }
      get_announcement_batch_delivery_context: {
        Args: { p_batch_id: string }
        Returns: {
          body: string
          notification_id: string
          recipient_user_id: string
        }[]
      }
      get_announcement_recipient_candidates: {
        Args: never
        Returns: {
          announcement_enabled: boolean
          first_name: string
          id: string
          last_name: string
          role: string
        }[]
      }
      get_audit_log: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: {
          action: string
          actor_name: string
          created_at: string
          id: string
          metadata: Json
          target_id: string
          target_type: string
        }[]
      }
      get_blocking_checkout_attempt_for_payment: {
        Args: { p_club_id: string; p_payment_id: string }
        Returns: {
          id: string
          livemode: boolean
          stripe_account_id: string
          stripe_checkout_session_id: string
        }[]
      }
      get_calendar_feed_rows: { Args: { p_token_hash: string }; Returns: Json }
      get_club_invites: {
        Args: never
        Returns: {
          accepted_at: string
          accepted_by: string
          code: string
          created_at: string
          email: string
          expires_at: string
          id: string
          revoked_at: string
          role: string
        }[]
      }
      get_club_member_waiver_compliance: {
        Args: never
        Returns: {
          roster_member_id: string
          status: string
          waiver_configured: boolean
        }[]
      }
      get_club_pros: {
        Args: never
        Returns: {
          first_name: string
          id: string
          is_lesson_provider: boolean
          last_name: string
          role: string
        }[]
      }
      get_club_stripe_account_ref: {
        Args: { p_club_id: string; p_livemode: boolean }
        Returns: string
      }
      get_club_stripe_connect_status: {
        Args: { p_club_id: string; p_livemode: boolean }
        Returns: {
          card_payments_status: string
          connected: boolean
          last_synced_at: string
        }[]
      }
      get_communications_activity: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: {
          audience_mode: string
          batch_id: string
          body: string
          email_failed_count: number
          email_sent_count: number
          recipient_count: number
          sent_at: string
          title: string
        }[]
      }
      get_confirmed_lesson_reassignment_pros: {
        Args: never
        Returns: {
          first_name: string
          id: string
          is_lesson_provider: boolean
          last_name: string
          role: string
        }[]
      }
      get_court_utilization: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: {
          available_hours: number
          court_id: string
          court_name: string
          gross_reserved_hours: number
          gross_utilization_pct: number
          member_demand_reserved_hours: number
          member_demand_utilization_pct: number
        }[]
      }
      get_current_account_context: {
        Args: never
        Returns: {
          active_club_id: string
          club_name: string
          club_slug: string
          created_at: string
          first_name: string
          id: string
          is_lesson_provider: boolean
          last_name: string
          phone: string
          role: string
          status: string
          theme_key: string
          updated_at: string
        }[]
      }
      get_event_delivery_context: {
        Args: { p_notification_id: string }
        Returns: Json
      }
      get_event_eligible_members: {
        Args: { p_event_id: string }
        Returns: {
          display_name: string
          has_account: boolean
          profile_id: string
          roster_member_id: string
        }[]
      }
      get_event_guest_waiver_compliance: {
        Args: { p_event_id: string }
        Returns: {
          relationship_id: string
          status: string
          waiver_configured: boolean
        }[]
      }
      get_event_payment_for_checkout: {
        Args: { p_event_id: string }
        Returns: {
          amount_due_cents: number
          amount_paid_cents: number
          club_id: string
          currency: string
          event_starts_at: string
          payment_id: string
          payment_mode_at_creation: string
          status: string
        }[]
      }
      get_event_program_summary: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: {
          attendance_marked_count: number
          attendance_rate_pct: number
          attended_count: number
          cancelled_program_sessions: number
          cancelled_standalone_sessions: number
          confirmed_members: number
          fill_rate_pct: number
          guests: number
          no_show_count: number
          no_show_rate_pct: number
          program_sessions_held: number
          standalone_sessions_held: number
          total_capacity: number
          total_enrollment: number
          total_sessions_held: number
        }[]
      }
      get_event_recipient_sms_contact: {
        Args: { p_notification_id: string }
        Returns: Json
      }
      get_event_roster: {
        Args: { p_event_id: string }
        Returns: {
          attendance_status: string
          display_name: string
          offer_expires_at: string
          profile_id: string
          role: string
          roster_member_id: string
          status: string
          waitlist_position: number
        }[]
      }
      get_financial_range_summary: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: {
          collected_cents: number
          domain: string
          refunded_cents: number
        }[]
      }
      get_lesson_notification_id: {
        Args: { p_kind: string; p_request_id: string; p_user_id: string }
        Returns: Json
      }
      get_lesson_payment_for_checkout: {
        Args: { p_request_id: string }
        Returns: {
          amount_due_cents: number
          amount_paid_cents: number
          club_id: string
          currency: string
          payment_id: string
          payment_mode_at_creation: string
          status: string
        }[]
      }
      get_lesson_recipient_email: {
        Args: { p_request_id: string; p_user_id: string }
        Returns: string
      }
      get_lesson_roster_members: {
        Args: never
        Returns: {
          claimed_by: string
          first_name: string
          id: string
          last_name: string
        }[]
      }
      get_lesson_types: {
        Args: never
        Returns: {
          allowed_durations: number[]
          description: string
          id: string
          is_active: boolean
          max_participants: number
          name: string
          pricing_basis: string
          rate_notes: string
          unit_price_amount_cents: number
        }[]
      }
      get_member_activity_history: {
        Args: {
          p_cursor_id?: string
          p_cursor_ts?: string
          p_cursor_type?: string
          p_limit?: number
          p_member_id: string
        }
        Returns: {
          activity_id: string
          activity_type: string
          attendance_status: string
          details: Json
          ends_at: string
          outcome: string
          sort_ts: string
          starts_at: string
          status: string
          title: string
        }[]
      }
      get_member_engagement_summary: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: {
          active_member_snapshot_count: number
          engaged_member_count: number
          members_with_event_participation: number
          members_with_program_enrollment: number
          members_with_reservations: number
        }[]
      }
      get_member_notes: {
        Args: { p_member_id: string }
        Returns: {
          archived_at: string
          archived_by: string
          author_id: string
          author_name: string
          author_name_snapshot: string
          body: string
          created_at: string
          id: string
          is_archived: boolean
          member_id: string
          updated_at: string
        }[]
      }
      get_member_upcoming_activity: {
        Args: { p_member_id: string }
        Returns: {
          activity_id: string
          activity_type: string
          attendance_status: string
          details: Json
          ends_at: string
          outcome: string
          starts_at: string
          status: string
          title: string
        }[]
      }
      get_member_waiver_status: {
        Args: { p_roster_member_id: string }
        Returns: {
          accepted_at: string
          current_version_id: string
          is_required: boolean
          published_at: string
          status: string
          title: string
          version_number: number
          waiver_id: string
        }[]
      }
      get_members: {
        Args: never
        Returns: {
          created_at: string
          email: string
          first_name: string
          id: string
          is_lesson_provider: boolean
          last_name: string
          membership_status: string
          membership_type_id: string
          membership_type_name: string
          phone: string
          removed_at: string
          role: string
          status: string
        }[]
      }
      get_my_club_memberships: {
        Args: never
        Returns: {
          club_id: string
          club_name: string
          club_slug: string
          is_active_club: boolean
          is_lesson_provider: boolean
          role: string
          theme_key: string
        }[]
      }
      get_my_communication_settings: { Args: never; Returns: Json }
      get_my_lesson_requests: {
        Args: never
        Returns: {
          cancellation_reason: string
          confirmed_at: string
          created_at: string
          decline_reason: string
          duration_minutes: number
          id: string
          lesson_outcome: string
          lesson_type_id: string
          lesson_type_name: string
          linked_reservation_id: string
          member_note: string
          preferred_court_id: string
          preferred_court_name: string
          preferred_windows: Json
          pro_first_name: string
          pro_id: string
          pro_last_name: string
          proposed_court_id: string
          proposed_court_name: string
          proposed_ends_at: string
          proposed_starts_at: string
          status: string
          updated_at: string
        }[]
      }
      get_my_member_waiver_status: {
        Args: never
        Returns: {
          accepted_at: string
          body: string
          current_version_id: string
          is_required: boolean
          published_at: string
          status: string
          title: string
          version_number: number
          waiver_id: string
        }[]
      }
      get_my_reservation_player_participations: {
        Args: { p_expected_club_id: string }
        Returns: {
          court_id: string
          court_name: string
          ends_at: string
          format: string
          host_display_name: string
          reservation_id: string
          starts_at: string
        }[]
      }
      get_online_refundable_amount_for_payments: {
        Args: { p_payment_ids: string[] }
        Returns: {
          currency: string
          payment_id: string
          refundable_cents: number
        }[]
      }
      get_open_reservation_player_searches: {
        Args: { p_expected_club_id: string }
        Returns: {
          court_id: string
          court_name: string
          ends_at: string
          format: string
          host_display_name: string
          occupied_seats: number
          player_capacity: number
          remaining_spots: number
          reservation_id: string
          starts_at: string
        }[]
      }
      get_payment_states_for_domains: {
        Args: { p_domain_ids: string[]; p_domain_type: string }
        Returns: {
          current_amount_due_cents: number
          current_amount_paid_cents: number
          current_currency: string
          current_obligation_cycle: number
          current_payment_id: string
          current_status: string
          domain_id: string
          unresolved_prior: Json
        }[]
      }
      get_pending_refund_requests_for_payments: {
        Args: { p_payment_ids: string[] }
        Returns: {
          attempt_status: string
          created_at: string
          notes: string
          payment_id: string
          reason: string
          refund_attempt_id: string
          request_id: string
          requested_amount_cents: number
          requested_by: string
          requested_by_name: string
        }[]
      }
      get_pro_availability_windows: {
        Args: { p_pro_id?: string }
        Returns: {
          day_of_week: number
          end_time: string
          id: string
          is_active: boolean
          pro_id: string
          start_time: string
        }[]
      }
      get_pro_blackouts: {
        Args: { p_from_date?: string; p_pro_id?: string; p_to_date?: string }
        Returns: {
          blackout_date: string
          created_at: string
          id: string
          pro_id: string
          reason: string
        }[]
      }
      get_pro_lesson_requests: {
        Args: { p_pro_filter?: string; p_status?: string }
        Returns: {
          cancellation_reason: string
          confirmed_at: string
          created_at: string
          decline_reason: string
          duration_minutes: number
          id: string
          last_actor_role: string
          lesson_outcome: string
          lesson_type_id: string
          lesson_type_name: string
          linked_reservation_id: string
          member_claimed: boolean
          member_first_name: string
          member_id: string
          member_last_name: string
          member_note: string
          preferred_court_id: string
          preferred_court_name: string
          preferred_windows: Json
          pro_first_name: string
          pro_id: string
          pro_last_name: string
          proposed_court_id: string
          proposed_court_name: string
          proposed_ends_at: string
          proposed_starts_at: string
          roster_member_id: string
          status: string
          updated_at: string
        }[]
      }
      get_program_eligible_members: {
        Args: { p_program_id: string }
        Returns: {
          display_name: string
          first_name: string
          last_name: string
          profile_id: string
        }[]
      }
      get_program_eligible_roster_members: {
        Args: { p_program_id: string }
        Returns: {
          display_name: string
          first_name: string
          last_name: string
          roster_member_id: string
        }[]
      }
      get_program_payment_for_checkout: {
        Args: { p_program_id: string }
        Returns: {
          amount_due_cents: number
          amount_paid_cents: number
          club_id: string
          currency: string
          payment_id: string
          payment_mode_at_creation: string
          status: string
        }[]
      }
      get_program_roster: {
        Args: { p_program_id: string }
        Returns: {
          created_at: string
          email: string
          enrollment_id: string
          first_name: string
          last_name: string
          offer_expires_at: string
          profile_id: string
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string
        }[]
      }
      get_reporting_overview: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: {
          active_member_count: number
          cancellation_rate_pct: number
          cancelled_reservations: number
          gross_utilization_pct: number
          member_demand_utilization_pct: number
          outstanding_waitlist_count: number
          session_fill_rate_pct: number
          sessions_held: number
          total_reservations: number
          total_session_capacity: number
          total_session_enrollment: number
        }[]
      }
      get_reservation_delivery_context: {
        Args: { p_notification_id: string }
        Returns: Json
      }
      get_reservation_eligible_roster_members: {
        Args: { p_expected_club_id: string; p_reservation_id: string }
        Returns: {
          display_name: string
          is_reservation_holder: boolean
          role: string
          roster_member_id: string
        }[]
      }
      get_reservation_guest_waiver_compliance: {
        Args: { p_expected_club_id: string; p_reservation_id: string }
        Returns: {
          relationship_id: string
          status: string
          waiver_configured: boolean
        }[]
      }
      get_reservation_payment_for_checkout: {
        Args: { p_reservation_id: string }
        Returns: {
          amount_due_cents: number
          amount_paid_cents: number
          club_id: string
          currency: string
          payment_id: string
          payment_mode_at_creation: string
          status: string
        }[]
      }
      get_reservation_player_search: {
        Args: { p_expected_club_id: string; p_reservation_id: string }
        Returns: {
          effective_is_open: boolean
          effective_open_block_reason: string
          is_open: boolean
          occupied_seats: number
          player_capacity: number
          remaining_spots: number
          reservation_id: string
        }[]
      }
      get_reservation_recipient_sms_contact: {
        Args: { p_notification_id: string }
        Returns: Json
      }
      get_reservation_roster: {
        Args: { p_expected_club_id: string; p_reservation_id: string }
        Returns: {
          display_name: string
          is_holder: boolean
          kind: string
          relationship_id: string
          reservation_status: string
          roster_member_id: string
        }[]
      }
      get_reservation_summary: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: {
          admin_block_count: number
          cancellation_rate_pct: number
          cancelled_reservations: number
          confirmed_reservations: number
          daily_series: Json
          event_count: number
          maintenance_count: number
          member_booking_count: number
          pending_reservations: number
          pro_lesson_count: number
          total_reservations: number
        }[]
      }
      get_roster_member_email_for_notification: {
        Args: { p_expected_club_id: string; p_roster_member_id: string }
        Returns: string
      }
      get_roster_members: {
        Args: { p_include_inactive?: boolean }
        Returns: {
          created_at: string
          created_by: string
          email: string
          first_name: string
          id: string
          last_name: string
          membership_status: string
          membership_type_id: string
          membership_type_name: string
          notes: string
          phone: string
          removed_at: string
          role: string
          status: string
        }[]
      }
      get_user_email_for_notification: {
        Args: { p_notification_id: string }
        Returns: string
      }
      get_waitlist_delivery_context: {
        Args: { p_notification_id: string }
        Returns: Json
      }
      get_waitlist_demand: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: {
          event_live_offer_entries: number
          event_waitlisted_entries: number
          program_live_offer_entries: number
          program_waitlisted_entries: number
          total_outstanding_entries: number
        }[]
      }
      get_waitlist_recipient_email: {
        Args: { p_notification_id: string }
        Returns: string
      }
      get_waitlist_recipient_sms_contact: {
        Args: { p_notification_id: string }
        Returns: Json
      }
      has_active_calendar_feed_token: {
        Args: { p_feed_type: string }
        Returns: boolean
      }
      is_active_club_member: {
        Args: { p_club_id: string; p_roster_member_id: string }
        Returns: boolean
      }
      issue_calendar_feed_token: {
        Args: {
          p_expected_club_id: string
          p_feed_type: string
          p_token_hash: string
        }
        Returns: undefined
      }
      join_event: {
        Args: { p_event_id: string }
        Returns: {
          attendance_status: string | null
          cancelled_at: string | null
          confirmed_at: string | null
          created_at: string
          event_id: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          role: string
          roster_member_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "event_participants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      join_program: {
        Args: { p_program_id: string }
        Returns: {
          created_at: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "program_enrollments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      join_reservation_player_search: {
        Args: { p_expected_club_id: string; p_reservation_id: string }
        Returns: string
      }
      leave_event: { Args: { p_event_id: string }; Returns: string }
      leave_event_v2: { Args: { p_event_id: string }; Returns: Json }
      leave_program: {
        Args: { p_program_id: string }
        Returns: {
          created_at: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "program_enrollments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      leave_reservation_participation: {
        Args: { p_expected_club_id: string; p_reservation_id: string }
        Returns: string
      }
      list_club_blocking_checkout_attempts: {
        Args: { p_club_id: string }
        Returns: {
          payment_id: string
        }[]
      }
      list_event_blocking_checkout_attempts: {
        Args: { p_club_id: string; p_event_id: string }
        Returns: {
          payment_id: string
        }[]
      }
      list_program_blocking_checkout_attempts: {
        Args: { p_club_id: string; p_program_id: string }
        Returns: {
          payment_id: string
        }[]
      }
      mark_attendance: {
        Args: {
          p_attendance_status: string
          p_event_id: string
          p_profile_id: string
        }
        Returns: undefined
      }
      mark_attendance_guest: {
        Args: {
          p_attendance_status: string
          p_event_id: string
          p_expected_club_id: string
          p_guest_id: string
        }
        Returns: undefined
      }
      mark_attendance_roster_participant: {
        Args: {
          p_attendance_status: string
          p_event_id: string
          p_expected_club_id: string
          p_roster_member_id: string
        }
        Returns: undefined
      }
      mark_lesson_outcome: {
        Args: { p_outcome: string; p_request_id: string }
        Returns: undefined
      }
      mark_refund_attempt_local_failure: {
        Args: { p_failure_reason: string; p_refund_attempt_id: string }
        Returns: undefined
      }
      mint_event_guest_waiver_invitation: {
        Args: { p_event_id: string; p_guest_id: string; p_token_hash: string }
        Returns: string
      }
      mint_reservation_guest_waiver_invitation: {
        Args: {
          p_expected_club_id: string
          p_guest_id: string
          p_reservation_id: string
          p_token_hash: string
        }
        Returns: string
      }
      notify_reservation_cancelled_by_member: {
        Args: { p_reservation_id: string }
        Returns: undefined
      }
      open_event_payment_checkout_attempt: {
        Args: {
          p_actor_id: string
          p_club_id: string
          p_event_id: string
          p_livemode: boolean
          p_stripe_account_id: string
        }
        Returns: {
          action: string
          amount_expected_cents: number
          club_id: string
          created_at: string
          created_by: string
          currency_expected: string
          id: string
          livemode: boolean
          payment_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string
          stripe_session_expires_at: string
          updated_at: string
        }[]
      }
      open_lesson_payment_checkout_attempt: {
        Args: {
          p_actor_id: string
          p_club_id: string
          p_livemode: boolean
          p_request_id: string
          p_stripe_account_id: string
        }
        Returns: {
          action: string
          amount_expected_cents: number
          club_id: string
          created_at: string
          created_by: string
          currency_expected: string
          id: string
          livemode: boolean
          payment_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string
          stripe_session_expires_at: string
          updated_at: string
        }[]
      }
      open_payment_checkout_attempt: {
        Args: {
          p_actor_id: string
          p_club_id: string
          p_livemode: boolean
          p_payment_id: string
          p_stripe_account_id: string
        }
        Returns: {
          action: string
          amount_expected_cents: number
          club_id: string
          created_at: string
          created_by: string
          currency_expected: string
          id: string
          livemode: boolean
          payment_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string
          stripe_session_expires_at: string
          updated_at: string
        }[]
      }
      open_payment_refund_attempt: {
        Args: {
          p_actor_id: string
          p_admin_reason?: string
          p_club_id: string
          p_payment_id: string
          p_requested_amount_cents: number
        }
        Returns: {
          club_id: string
          currency: string
          id: string
          livemode: boolean
          payment_id: string
          requested_amount_cents: number
          source_checkout_attempt_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string
        }[]
      }
      open_program_payment_checkout_attempt: {
        Args: {
          p_actor_id: string
          p_club_id: string
          p_livemode: boolean
          p_program_id: string
          p_stripe_account_id: string
        }
        Returns: {
          action: string
          amount_expected_cents: number
          club_id: string
          created_at: string
          created_by: string
          currency_expected: string
          id: string
          livemode: boolean
          payment_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string
          stripe_session_expires_at: string
          updated_at: string
        }[]
      }
      preview_announcement_recipients: {
        Args: { p_audience_mode: string; p_recipient_user_ids: string[] }
        Returns: {
          eligible_count: number
          eligible_user_ids: string[]
        }[]
      }
      preview_court_reservation_price: {
        Args: {
          p_court_id: string
          p_ends_at: string
          p_expected_club_id?: string
          p_roster_member_id?: string
          p_starts_at: string
        }
        Returns: {
          applied_rate_period_id: string
          applied_rate_period_name: string
          applied_rate_source: string
          currency: string
          hourly_rate_cents: number
          membership_pricing_class: string
          price_amount_cents: number
        }[]
      }
      preview_member_lesson_cancellation_policy: {
        Args: { p_request_id: string }
        Returns: {
          cutoff_at: string
          state: string
          within_grace: boolean
        }[]
      }
      preview_member_reservation_cancellation_policy: {
        Args: { p_expected_club_id: string; p_reservation_id: string }
        Returns: {
          cutoff_at: string
          state: string
          within_grace: boolean
        }[]
      }
      preview_program_sessions: {
        Args: {
          p_from_date?: string
          p_program_id: string
          p_through_date?: string
        }
        Returns: {
          already_generated: boolean
          conflict_reason: string
          conflicting_event_id: string
          conflicting_reservation_id: string
          court_id: string
          court_name: string
          ends_at: string
          has_conflict: boolean
          occurrence_date: string
          program_schedule_rule_id: string
          starts_at: string
        }[]
      }
      process_stripe_connect_account_event: {
        Args: {
          p_card_payments_status: string
          p_event_type: string
          p_livemode: boolean
          p_stripe_account_id: string
          p_stripe_event_id: string
        }
        Returns: {
          already_processed: boolean
          matched: boolean
        }[]
      }
      process_stripe_dispute_webhook_event: {
        Args: {
          p_amount_cents: number
          p_currency: string
          p_event_type: string
          p_evidence_due_by: string
          p_is_charge_refundable: boolean
          p_livemode: boolean
          p_reason: string
          p_status: string
          p_stripe_account_id: string
          p_stripe_charge_id: string
          p_stripe_created_at: string
          p_stripe_dispute_id: string
          p_stripe_event_id: string
          p_stripe_payment_intent_id: string
        }
        Returns: boolean
      }
      process_stripe_payment_event: {
        Args: {
          p_amount_total_cents: number
          p_currency: string
          p_event_type: string
          p_livemode: boolean
          p_stripe_account_id: string
          p_stripe_checkout_session_id: string
          p_stripe_event_id: string
          p_stripe_payment_intent_id: string
        }
        Returns: {
          already_processed: boolean
          matched: boolean
        }[]
      }
      process_stripe_refund_webhook_event: {
        Args: {
          p_amount_cents: number
          p_currency: string
          p_event_type: string
          p_failure_reason?: string
          p_livemode: boolean
          p_refund_attempt_id: string
          p_status: string
          p_stripe_account_id: string
          p_stripe_event_id: string
          p_stripe_payment_intent_id: string
          p_stripe_refund_id: string
        }
        Returns: {
          already_processed: boolean
          matched: boolean
        }[]
      }
      propose_lesson_time: {
        Args: {
          p_court_id?: string
          p_ends_at: string
          p_expected_updated_at: string
          p_request_id: string
          p_starts_at: string
        }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      publish_guest_waiver_version: {
        Args: { p_version_id: string }
        Returns: undefined
      }
      publish_member_waiver_version: {
        Args: { p_version_id: string }
        Returns: undefined
      }
      publish_waiver_pdf_version: {
        Args: {
          p_actor_user_id: string
          p_audience: string
          p_club_id: string
          p_file_size_bytes: number
          p_original_filename: string
          p_sha256_digest: string
          p_title: string
          p_version_id: string
        }
        Returns: {
          published_at: string
          storage_path: string
          version_id: string
          version_number: number
        }[]
      }
      reassign_lesson_provider: {
        Args: { p_new_pro_id: string; p_request_id: string }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_checkout_session_created: {
        Args: {
          p_attempt_id: string
          p_stripe_checkout_session_id: string
          p_stripe_session_expires_at: string
        }
        Returns: undefined
      }
      record_delivery_attempt: {
        Args: {
          p_channel: string
          p_error?: string
          p_notification_id: string
          p_provider?: string
          p_provider_message_id?: string
          p_sent_at?: string
          p_status: string
        }
        Returns: string
      }
      record_manual_payment: {
        Args: {
          p_amount_cents: number
          p_external_reference?: string
          p_method: string
          p_notes?: string
          p_occurred_at?: string
          p_payment_id: string
        }
        Returns: {
          amount_due_cents: number
          amount_paid_cents: number
          club_id: string
          created_at: string
          created_by: string | null
          currency: string
          domain_id: string
          domain_type: string
          id: string
          obligation_cycle: number
          payment_mode_at_creation: string
          roster_member_id: string | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "payments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_refund: {
        Args: {
          p_amount_cents: number
          p_external_reference?: string
          p_method?: string
          p_notes?: string
          p_occurred_at?: string
          p_payment_id: string
        }
        Returns: {
          amount_due_cents: number
          amount_paid_cents: number
          club_id: string
          created_at: string
          created_by: string | null
          currency: string
          domain_id: string
          domain_type: string
          id: string
          obligation_cycle: number
          payment_mode_at_creation: string
          roster_member_id: string | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "payments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_roster_operational_email: {
        Args: {
          p_error?: string
          p_expected_club_id: string
          p_kind: string
          p_provider_message_id?: string
          p_roster_member_id: string
          p_status: string
        }
        Returns: undefined
      }
      reject_refund_request: {
        Args: { p_rejection_reason: string; p_request_id: string }
        Returns: {
          beneficiary_user_id: string | null
          club_id: string
          created_at: string
          id: string
          notes: string | null
          payment_id: string
          policy_refundable_cents_at_cancellation: number | null
          reason: string
          refund_attempt_id: string | null
          rejection_reason: string | null
          requested_amount_cents: number
          requested_by: string
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "payment_refund_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      remove_club_member: {
        Args: { p_target_user_id: string }
        Returns: undefined
      }
      remove_program_member: {
        Args: { p_profile_id: string; p_program_id: string }
        Returns: {
          created_at: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "program_enrollments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      remove_program_roster_member: {
        Args: {
          p_expected_club_id: string
          p_program_id: string
          p_roster_member_id: string
        }
        Returns: {
          created_at: string
          id: string
          offer_expires_at: string | null
          price_amount_cents: number | null
          profile_id: string | null
          program_id: string
          roster_member_id: string
          status: string
          updated_at: string
          waitlisted_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "program_enrollments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      remove_reservation_guest: {
        Args: {
          p_expected_club_id: string
          p_guest_id: string
          p_reservation_id: string
        }
        Returns: string
      }
      remove_reservation_participant: {
        Args: {
          p_expected_club_id: string
          p_participant_id: string
          p_reservation_id: string
        }
        Returns: string
      }
      remove_roster_member: {
        Args: { p_roster_member_id: string }
        Returns: undefined
      }
      rename_court: {
        Args: { p_court_id: string; p_name: string }
        Returns: undefined
      }
      reorder_courts: { Args: { p_court_order: string[] }; Returns: undefined }
      resend_club_invite: {
        Args: { p_expires_at?: string; p_old_code: string }
        Returns: string
      }
      resolve_guest_waiver_invitation: {
        Args: { p_token_hash: string }
        Returns: {
          accepted_at: string
          club_id: string
          club_name: string
          current_version_id: string
          event_guest_id: string
          guest_display_name: string
          invitation_id: string
          is_current_accepted: boolean
          is_required: boolean
          reservation_guest_id: string
          version_title: string
          waiver_id: string
        }[]
      }
      restore_club_member: {
        Args: { p_target_user_id: string }
        Returns: undefined
      }
      restore_member_note: { Args: { p_note_id: string }; Returns: undefined }
      restore_roster_member: {
        Args: { p_roster_member_id: string }
        Returns: undefined
      }
      reverse_payment_event: {
        Args: { p_event_id: string; p_reason?: string }
        Returns: {
          amount_due_cents: number
          amount_paid_cents: number
          club_id: string
          created_at: string
          created_by: string | null
          currency: string
          domain_id: string
          domain_type: string
          id: string
          obligation_cycle: number
          payment_mode_at_creation: string
          roster_member_id: string | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "payments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_calendar_feed_token: {
        Args: { p_expected_club_id: string; p_feed_type: string }
        Returns: undefined
      }
      revoke_club_invite: { Args: { p_code: string }; Returns: undefined }
      send_announcement_v2: {
        Args: {
          p_audience_mode: string
          p_body: string
          p_recipient_user_ids: string[]
          p_title: string
        }
        Returns: Json
      }
      set_active_club: {
        Args: { p_club_id: string }
        Returns: {
          club_id: string
          is_lesson_provider: boolean
          role: string
          status: string
        }[]
      }
      set_club_tier_for_operator: {
        Args: { p_club_id: string; p_tier: string }
        Returns: {
          club_id: string
          status: string
          tier: string
        }[]
      }
      set_court_active: {
        Args: { p_court_id: string; p_is_active: boolean }
        Returns: undefined
      }
      set_court_hourly_rate: {
        Args: {
          p_court_id: string
          p_hourly_rate_cents: number
          p_hourly_rate_non_member_cents?: number
        }
        Returns: {
          club_id: string
          created_at: string
          display_order: number
          hourly_rate_cents: number | null
          hourly_rate_non_member_cents: number | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "courts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_court_rate_period_active: {
        Args: { p_active: boolean; p_id: string }
        Returns: {
          club_id: string
          created_at: string
          days_of_week: number[]
          ends_at_local: string
          hourly_rate_cents: number | null
          hourly_rate_non_member_cents: number | null
          id: string
          is_active: boolean
          name: string
          starts_at_local: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "court_rate_periods"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_event_member_joinable: {
        Args: { p_event_id: string; p_member_joinable: boolean }
        Returns: undefined
      }
      set_event_price_override: {
        Args: { p_event_id: string; p_price_amount_cents: number }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          cancelled_at: string | null
          capacity: number
          club_id: string
          court_count: number
          created_at: string
          created_by: string
          description: string | null
          ends_at: string
          event_type_id: string
          id: string
          is_program_exception: boolean
          member_joinable: boolean
          price_amount_cents: number | null
          program_id: string | null
          program_occurrence_date: string | null
          program_schedule_rule_id: string | null
          starts_at: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_event_type_active: {
        Args: { p_id: string; p_is_active: boolean }
        Returns: undefined
      }
      set_event_type_price: {
        Args: { p_default_price_amount_cents: number; p_id: string }
        Returns: {
          club_id: string
          color: string
          created_at: string
          default_capacity: number
          default_court_count: number
          default_duration_minutes: number
          default_price_amount_cents: number | null
          id: string
          is_active: boolean
          key: string
          label: string
          shows_participant_names: boolean
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "event_types"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_guest_waiver_required: {
        Args: { p_required: boolean }
        Returns: undefined
      }
      set_lesson_provider_status: {
        Args: { p_enabled: boolean; p_target_user_id: string }
        Returns: undefined
      }
      set_member_notes: {
        Args: { p_notes: string; p_target_user_id: string }
        Returns: undefined
      }
      set_member_role: {
        Args: { p_new_role: string; p_target_user_id: string }
        Returns: undefined
      }
      set_member_status: {
        Args: { p_new_status: string; p_target_user_id: string }
        Returns: undefined
      }
      set_member_waiver_required: {
        Args: { p_required: boolean }
        Returns: undefined
      }
      set_membership_type_active: {
        Args: { p_id: string; p_is_active: boolean }
        Returns: {
          club_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "membership_types"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_program_price: {
        Args: { p_price_amount_cents: number; p_program_id: string }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          club_id: string
          created_at: string
          created_by: string
          default_capacity: number
          description: string | null
          ends_on: string
          enrollment_model: string
          event_type_id: string
          id: string
          price_amount_cents: number | null
          starts_on: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "programs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_reservation_player_search: {
        Args: {
          p_expected_club_id: string
          p_player_capacity: number
          p_reservation_id: string
        }
        Returns: string
      }
      set_roster_member_membership_status: {
        Args: { p_membership_status: string; p_roster_member_id: string }
        Returns: {
          claimed_by: string | null
          club_id: string
          created_at: string
          created_by: string
          email: string | null
          first_name: string
          id: string
          last_name: string
          membership_status: string
          membership_type_id: string | null
          notes: string | null
          phone: string | null
          removed_at: string | null
          removed_by: string | null
          role: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "roster_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_roster_member_membership_type: {
        Args: { p_membership_type_id?: string; p_roster_member_id: string }
        Returns: {
          claimed_by: string | null
          club_id: string
          created_at: string
          created_by: string
          email: string | null
          first_name: string
          id: string
          last_name: string
          membership_status: string
          membership_type_id: string | null
          notes: string | null
          phone: string | null
          removed_at: string | null
          removed_by: string | null
          role: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "roster_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      sms_already_delivered: {
        Args: { p_notification_id: string }
        Returns: boolean
      }
      submit_lesson_request: {
        Args: {
          p_duration_minutes: number
          p_lesson_type_id?: string
          p_member_note?: string
          p_preferred_court_id?: string
          p_preferred_windows?: Json
          p_pro_id: string
        }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      submit_pilot_inquiry: {
        Args: {
          p_additional_details?: string
          p_approximate_member_count: number
          p_club_name: string
          p_contact_name: string
          p_court_count: number
          p_current_process: string
          p_email: string
          p_facility_type: string
          p_facility_type_other?: string
          p_fingerprint?: string
          p_operational_challenge: string
          p_phone?: string
          p_preferred_contact_method?: string
          p_preferred_operating_model: string
          p_source?: string
          p_website?: string
        }
        Returns: {
          deduped: boolean
          id: string
        }[]
      }
      supersede_checkout_attempt_and_open_fresh: {
        Args: {
          p_actor_id: string
          p_club_id: string
          p_livemode: boolean
          p_payment_id: string
          p_stale_attempt_id: string
          p_stripe_account_id: string
        }
        Returns: {
          action: string
          amount_expected_cents: number
          club_id: string
          created_at: string
          created_by: string
          currency_expected: string
          id: string
          livemode: boolean
          payment_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string
          stripe_session_expires_at: string
          updated_at: string
        }[]
      }
      supersede_event_checkout_attempt_and_open_fresh: {
        Args: {
          p_actor_id: string
          p_club_id: string
          p_event_id: string
          p_livemode: boolean
          p_stale_attempt_id: string
          p_stripe_account_id: string
        }
        Returns: {
          action: string
          amount_expected_cents: number
          club_id: string
          created_at: string
          created_by: string
          currency_expected: string
          id: string
          livemode: boolean
          payment_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string
          stripe_session_expires_at: string
          updated_at: string
        }[]
      }
      supersede_lesson_checkout_attempt_and_open_fresh: {
        Args: {
          p_actor_id: string
          p_club_id: string
          p_livemode: boolean
          p_request_id: string
          p_stale_attempt_id: string
          p_stripe_account_id: string
        }
        Returns: {
          action: string
          amount_expected_cents: number
          club_id: string
          created_at: string
          created_by: string
          currency_expected: string
          id: string
          livemode: boolean
          payment_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string
          stripe_session_expires_at: string
          updated_at: string
        }[]
      }
      supersede_program_checkout_attempt_and_open_fresh: {
        Args: {
          p_actor_id: string
          p_club_id: string
          p_livemode: boolean
          p_program_id: string
          p_stale_attempt_id: string
          p_stripe_account_id: string
        }
        Returns: {
          action: string
          amount_expected_cents: number
          club_id: string
          created_at: string
          created_by: string
          currency_expected: string
          id: string
          livemode: boolean
          payment_id: string
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string
          stripe_session_expires_at: string
          updated_at: string
        }[]
      }
      unarchive_event: {
        Args: { p_event_id: string }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          cancelled_at: string | null
          capacity: number
          club_id: string
          court_count: number
          created_at: string
          created_by: string
          description: string | null
          ends_at: string
          event_type_id: string
          id: string
          is_program_exception: boolean
          member_joinable: boolean
          price_amount_cents: number | null
          program_id: string | null
          program_occurrence_date: string | null
          program_schedule_rule_id: string | null
          starts_at: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      unarchive_program: {
        Args: { p_program_id: string }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          club_id: string
          created_at: string
          created_by: string
          default_capacity: number
          description: string | null
          ends_on: string
          enrollment_model: string
          event_type_id: string
          id: string
          price_amount_cents: number | null
          starts_on: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "programs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_club_memberships_enabled: {
        Args: { p_enabled: boolean }
        Returns: {
          booking_window_days: number
          cancellation_grace_minutes: number
          cancellation_window_hours: number
          club_id: string
          created_at: string
          currency: string
          default_court_hourly_rate_cents: number | null
          default_court_hourly_rate_non_member_cents: number | null
          id: string
          memberships_enabled: boolean
          payment_mode: string
          rules_and_policies: string | null
          updated_at: string
          waitlist_offer_window_hours: number
        }
        SetofOptions: {
          from: "*"
          to: "club_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_club_name: { Args: { p_name: string }; Returns: undefined }
      update_club_payment_mode: {
        Args: { p_payment_mode: string }
        Returns: {
          booking_window_days: number
          cancellation_grace_minutes: number
          cancellation_window_hours: number
          club_id: string
          created_at: string
          currency: string
          default_court_hourly_rate_cents: number | null
          default_court_hourly_rate_non_member_cents: number | null
          id: string
          memberships_enabled: boolean
          payment_mode: string
          rules_and_policies: string | null
          updated_at: string
          waitlist_offer_window_hours: number
        }
        SetofOptions: {
          from: "*"
          to: "club_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_club_pricing: {
        Args: {
          p_currency: string
          p_default_court_hourly_rate_cents: number
          p_default_court_hourly_rate_non_member_cents?: number
        }
        Returns: {
          booking_window_days: number
          cancellation_grace_minutes: number
          cancellation_window_hours: number
          club_id: string
          created_at: string
          currency: string
          default_court_hourly_rate_cents: number | null
          default_court_hourly_rate_non_member_cents: number | null
          id: string
          memberships_enabled: boolean
          payment_mode: string
          rules_and_policies: string | null
          updated_at: string
          waitlist_offer_window_hours: number
        }
        SetofOptions: {
          from: "*"
          to: "club_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_club_rules_and_policies: {
        Args: { p_rules_and_policies: string }
        Returns: undefined
      }
      update_club_settings: {
        Args: {
          p_booking_window_days: number
          p_cancellation_grace_minutes?: number
          p_cancellation_window_hours: number
          p_waitlist_offer_window_hours?: number
        }
        Returns: {
          booking_window_days: number
          cancellation_grace_minutes: number
          cancellation_window_hours: number
          club_id: string
          created_at: string
          currency: string
          default_court_hourly_rate_cents: number | null
          default_court_hourly_rate_non_member_cents: number | null
          id: string
          memberships_enabled: boolean
          payment_mode: string
          rules_and_policies: string | null
          updated_at: string
          waitlist_offer_window_hours: number
        }
        SetofOptions: {
          from: "*"
          to: "club_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_club_theme: { Args: { p_theme_key: string }; Returns: undefined }
      update_club_timezone: { Args: { p_timezone: string }; Returns: undefined }
      update_event: {
        Args: {
          p_capacity: number
          p_court_ids: string[]
          p_description?: string
          p_ends_at: string
          p_event_id: string
          p_event_type_id: string
          p_expected_club_id: string
          p_expected_updated_at: string
          p_starts_at: string
          p_title: string
        }
        Returns: Json
      }
      update_event_type: {
        Args: { p_color: string; p_id: string; p_label: string }
        Returns: {
          club_id: string
          color: string
          created_at: string
          default_capacity: number
          default_court_count: number
          default_duration_minutes: number
          default_price_amount_cents: number | null
          id: string
          is_active: boolean
          key: string
          label: string
          shows_participant_names: boolean
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "event_types"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_guest_waiver_draft: {
        Args: { p_body: string; p_title: string; p_version_id: string }
        Returns: undefined
      }
      update_maintenance_block: {
        Args: {
          p_court_id: string
          p_ends_at: string
          p_expected_club_id: string
          p_expected_updated_at: string
          p_notes?: string
          p_reservation_id: string
          p_show_notes_to_members?: boolean
          p_starts_at: string
        }
        Returns: Json
      }
      update_member_note: {
        Args: { p_body: string; p_note_id: string }
        Returns: undefined
      }
      update_member_reservation: {
        Args: {
          p_court_id: string
          p_ends_at: string
          p_expected_club_id: string
          p_expected_updated_at: string
          p_format?: string
          p_guest_names?: string[]
          p_notes?: string
          p_player_count?: number
          p_reservation_id: string
          p_roster_member_id: string
          p_starts_at: string
        }
        Returns: Json
      }
      update_member_waiver_draft: {
        Args: { p_body: string; p_title: string; p_version_id: string }
        Returns: undefined
      }
      update_membership_type: {
        Args: { p_id: string; p_name: string }
        Returns: {
          club_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "membership_types"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_notification_preference: {
        Args: { p_enabled: boolean; p_kind: string }
        Returns: undefined
      }
      update_operating_hours: {
        Args: { p_dry_run?: boolean; p_hours: Json }
        Returns: Json
      }
      update_program: {
        Args: {
          p_default_capacity: number
          p_description?: string
          p_ends_on: string
          p_enrollment_model: string
          p_event_type_id: string
          p_program_id: string
          p_rules: Json
          p_starts_on: string
          p_title: string
        }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          club_id: string
          created_at: string
          created_by: string
          default_capacity: number
          description: string | null
          ends_on: string
          enrollment_model: string
          event_type_id: string
          id: string
          price_amount_cents: number | null
          starts_on: string
          status: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "programs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_roster_member: {
        Args: {
          p_email?: string
          p_first_name: string
          p_id: string
          p_last_name: string
          p_notes?: string
          p_phone?: string
          p_role?: string
        }
        Returns: undefined
      }
      update_sms_preference: {
        Args: { p_ip?: string; p_sms_opt_in: boolean }
        Returns: undefined
      }
      upsert_club_stripe_account: {
        Args: {
          p_actor_id: string
          p_card_payments_status: string
          p_club_id: string
          p_livemode: boolean
          p_stripe_account_id: string
        }
        Returns: {
          card_payments_status: string
          club_id: string
          created_at: string
          created_by: string | null
          id: string
          last_synced_at: string | null
          livemode: boolean
          stripe_account_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "club_stripe_accounts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_court_rate_period: {
        Args: {
          p_days_of_week: number[]
          p_ends_at_local: string
          p_hourly_rate_cents?: number
          p_hourly_rate_non_member_cents?: number
          p_id: string
          p_name: string
          p_starts_at_local: string
        }
        Returns: {
          club_id: string
          created_at: string
          days_of_week: number[]
          ends_at_local: string
          hourly_rate_cents: number | null
          hourly_rate_non_member_cents: number | null
          id: string
          is_active: boolean
          name: string
          starts_at_local: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "court_rate_periods"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_lesson_type: {
        Args: {
          p_allowed_durations?: number[]
          p_description?: string
          p_id?: string
          p_max_participants?: number
          p_name?: string
          p_pricing_basis?: string
          p_rate_notes?: string
          p_unit_price_amount_cents?: number
        }
        Returns: string
      }
      upsert_operating_hours_override: {
        Args: {
          p_closes_at?: string
          p_dry_run?: boolean
          p_is_closed: boolean
          p_note?: string
          p_opens_at?: string
          p_override_date: string
        }
        Returns: Json
      }
      upsert_pro_availability_window: {
        Args: {
          p_day_of_week: number
          p_end_time: string
          p_pro_id?: string
          p_start_time: string
          p_window_id?: string
        }
        Returns: string
      }
      upsert_pro_blackout: {
        Args: { p_blackout_date: string; p_pro_id?: string; p_reason?: string }
        Returns: string
      }
      user_pref_enabled: {
        Args: { p_kind: string; p_user_id: string }
        Returns: boolean
      }
      validate_club_invite: { Args: { p_code: string }; Returns: Json }
      void_payment_obligation: {
        Args: { p_payment_id: string; p_reason?: string }
        Returns: {
          amount_due_cents: number
          amount_paid_cents: number
          club_id: string
          created_at: string
          created_by: string | null
          currency: string
          domain_id: string
          domain_type: string
          id: string
          obligation_cycle: number
          payment_mode_at_creation: string
          roster_member_id: string | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "payments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      waive_payment: {
        Args: { p_payment_id: string; p_reason?: string }
        Returns: {
          amount_due_cents: number
          amount_paid_cents: number
          club_id: string
          created_at: string
          created_by: string | null
          currency: string
          domain_id: string
          domain_type: string
          id: string
          obligation_cycle: number
          payment_mode_at_creation: string
          roster_member_id: string | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "payments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      withdraw_lesson_request: {
        Args: { p_request_id: string }
        Returns: {
          cancellation_policy_state: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          club_id: string
          confirmed_at: string | null
          created_at: string
          decline_reason: string | null
          declined_at: string | null
          duration_minutes: number
          id: string
          last_actor_id: string | null
          last_actor_role: string | null
          lesson_outcome: string | null
          lesson_type_id: string | null
          linked_reservation_id: string | null
          member_id: string | null
          member_note: string | null
          preferred_court_id: string | null
          preferred_windows: Json | null
          price_amount_cents: number | null
          pricing_basis: string | null
          pro_id: string
          proposed_court_id: string | null
          proposed_ends_at: string | null
          proposed_starts_at: string | null
          roster_member_id: string
          status: string
          unit_price_amount_cents: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "lesson_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
