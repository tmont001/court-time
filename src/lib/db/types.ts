// Placeholder — regenerate after applying migrations:
//   pnpm dlx supabase gen types typescript --project-id <your-project-id> > src/lib/db/types.ts
//
// Until then, this file hand-mirrors the Phase 1 schema so the build succeeds.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      clubs: {
        Row: {
          id: string;
          name: string;
          slug: string;
          timezone: string;
          logo_url: string | null;
          theme_key: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          timezone?: string;
          logo_url?: string | null;
          theme_key?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          timezone?: string;
          logo_url?: string | null;
          theme_key?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      club_settings: {
        Row: {
          id: string;
          club_id: string;
          booking_window_days: number;
          cancellation_window_hours: number;
          cancellation_grace_minutes: number;
          waitlist_offer_window_hours: number;  // Phase 18A
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          club_id: string;
          booking_window_days?: number;
          cancellation_window_hours?: number;
          cancellation_grace_minutes?: number;
          waitlist_offer_window_hours?: number;  // Phase 18A
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          club_id?: string;
          booking_window_days?: number;
          cancellation_window_hours?: number;
          cancellation_grace_minutes?: number;
          waitlist_offer_window_hours?: number;  // Phase 18A
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "club_settings_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: true;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          }
        ];
      };
      profiles: {
        Row: {
          id: string;
          club_id: string | null;
          first_name: string | null;
          last_name: string | null;
          phone: string | null;
          role: "member" | "pro" | "admin";
          status: "active" | "inactive" | "suspended";
          sms_opt_in: boolean;
          sms_opted_in_at: string | null;
          sms_opted_in_ip: string | null;
          admin_notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          club_id?: string | null;
          first_name?: string | null;
          last_name?: string | null;
          phone?: string | null;
          role?: "member" | "pro" | "admin";
          status?: "active" | "inactive" | "suspended";
          sms_opt_in?: boolean;
          sms_opted_in_at?: string | null;
          sms_opted_in_ip?: string | null;
          admin_notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          club_id?: string | null;
          first_name?: string | null;
          last_name?: string | null;
          phone?: string | null;
          role?: "member" | "pro" | "admin";
          status?: "active" | "inactive" | "suspended";
          sms_opt_in?: boolean;
          sms_opted_in_at?: string | null;
          sms_opted_in_ip?: string | null;
          admin_notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "profiles_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          }
        ];
      };
      courts: {
        Row: {
          id: string;
          club_id: string;
          name: string;
          display_order: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          club_id: string;
          name: string;
          display_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          club_id?: string;
          name?: string;
          display_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "courts_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          }
        ];
      };
      operating_hours: {
        Row: {
          id: string;
          club_id: string;
          day_of_week: number;
          opens_at: string;
          closes_at: string;
          is_closed: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          club_id: string;
          day_of_week: number;
          opens_at: string;
          closes_at: string;
          is_closed?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          club_id?: string;
          day_of_week?: number;
          opens_at?: string;
          closes_at?: string;
          is_closed?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "operating_hours_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          }
        ];
      };
      operating_hours_override: {
        Row: {
          id: string;
          club_id: string;
          override_date: string;
          opens_at: string | null;
          closes_at: string | null;
          is_closed: boolean;
          note: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          club_id: string;
          override_date: string;
          opens_at?: string | null;
          closes_at?: string | null;
          is_closed?: boolean;
          note?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          club_id?: string;
          override_date?: string;
          opens_at?: string | null;
          closes_at?: string | null;
          is_closed?: boolean;
          note?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "operating_hours_override_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          }
        ];
      };
      event_types: {
        Row: {
          id: string;
          club_id: string;
          key: string;
          label: string;
          color: string;
          default_capacity: number;
          default_duration_minutes: number;
          default_court_count: number;
          shows_participant_names: boolean;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          club_id: string;
          key: string;
          label: string;
          color: string;
          default_capacity: number;
          default_duration_minutes: number;
          default_court_count: number;
          shows_participant_names?: boolean;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          club_id?: string;
          key?: string;
          label?: string;
          color?: string;
          default_capacity?: number;
          default_duration_minutes?: number;
          default_court_count?: number;
          shows_participant_names?: boolean;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "event_types_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          }
        ];
      };
      reservations: {
        Row: {
          id: string;
          club_id: string;
          court_id: string;
          owner_user_id: string;
          starts_at: string;
          ends_at: string;
          status: "pending" | "confirmed" | "cancelled";
          reason: "member_booking" | "maintenance" | "admin_block" | "event";
          player_count: number | null;
          format: "singles" | "doubles" | null;
          guest_names: string[] | null;
          notes: string | null;
          show_notes_to_members: boolean;
          event_id: string | null;
          created_by: string;
          created_at: string;
          updated_at: string;
          cancelled_at: string | null;
          cancelled_by: string | null;
          cancellation_kind: "member" | "admin" | "system" | null;
        };
        Insert: {
          id?: string;
          club_id: string;
          court_id: string;
          owner_user_id: string;
          starts_at: string;
          ends_at: string;
          status?: "pending" | "confirmed" | "cancelled";
          reason?: "member_booking" | "maintenance" | "admin_block" | "event";
          player_count?: number | null;
          format?: "singles" | "doubles" | null;
          guest_names?: string[] | null;
          notes?: string | null;
          show_notes_to_members?: boolean;
          event_id?: string | null;
          created_by: string;
          created_at?: string;
          updated_at?: string;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          cancellation_kind?: "member" | "admin" | "system" | null;
        };
        Update: {
          id?: string;
          club_id?: string;
          court_id?: string;
          owner_user_id?: string;
          starts_at?: string;
          ends_at?: string;
          status?: "pending" | "confirmed" | "cancelled";
          reason?: "member_booking" | "maintenance" | "admin_block" | "event";
          player_count?: number | null;
          format?: "singles" | "doubles" | null;
          guest_names?: string[] | null;
          notes?: string | null;
          show_notes_to_members?: boolean;
          event_id?: string | null;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          cancellation_kind?: "member" | "admin" | "system" | null;
        };
        Relationships: [
          {
            foreignKeyName: "reservations_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reservations_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "courts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reservations_owner_user_id_fkey";
            columns: ["owner_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reservations_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          }
        ];
      };
      events: {
        Row: {
          id: string;
          club_id: string;
          event_type_id: string;
          title: string;
          description: string | null;
          starts_at: string;
          ends_at: string;
          capacity: number;
          court_count: number;
          status: "scheduled" | "cancelled";
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          club_id: string;
          event_type_id: string;
          title: string;
          description?: string | null;
          starts_at: string;
          ends_at: string;
          capacity: number;
          court_count?: number;
          status?: "scheduled" | "cancelled";
          created_by: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          club_id?: string;
          event_type_id?: string;
          title?: string;
          description?: string | null;
          starts_at?: string;
          ends_at?: string;
          capacity?: number;
          court_count?: number;
          status?: "scheduled" | "cancelled";
          created_by?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "events_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "events_event_type_id_fkey";
            columns: ["event_type_id"];
            isOneToOne: false;
            referencedRelation: "event_types";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "events_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      audit_log: {
        Row: {
          id:          string;
          club_id:     string;
          actor_id:    string;
          action:      string;
          target_type: string;
          target_id:   string;
          metadata:    Json | null;
          created_at:  string;
        };
        Insert: {
          id?:         string;
          club_id:     string;
          actor_id:    string;
          action:      string;
          target_type: string;
          target_id:   string;
          metadata?:   Json | null;
          created_at?: string;
        };
        Update: {
          id?:          string;
          club_id?:     string;
          actor_id?:    string;
          action?:      string;
          target_type?: string;
          target_id?:   string;
          metadata?:    Json | null;
          created_at?:  string;
        };
        Relationships: [
          {
            foreignKeyName: "audit_log_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audit_log_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      event_guests: {
        Row: {
          id:                string;
          event_id:          string;
          display_name:      string;
          added_by:          string;
          roster_member_id:  string | null;
          created_at:        string;
        };
        Insert: {
          id?:               string;
          event_id:          string;
          display_name:      string;
          added_by:          string;
          roster_member_id?: string | null;
          created_at?:       string;
        };
        Update: {
          id?:               string;
          event_id?:         string;
          display_name?:     string;
          added_by?:         string;
          roster_member_id?: string | null;
          created_at?:       string;
        };
        Relationships: [
          {
            foreignKeyName: "event_guests_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "event_guests_added_by_fkey";
            columns: ["added_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      event_participants: {
        Row: {
          id: string;
          event_id: string;
          profile_id: string;
          role: "host" | "participant";
          status: "confirmed" | "cancelled" | "waitlisted" | "offered";  // Phase 18A: offered
          attendance_status: "attended" | "no_show" | null;
          offer_expires_at: string | null;  // Phase 18A
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          event_id: string;
          profile_id: string;
          role?: "host" | "participant";
          status?: "confirmed" | "cancelled" | "waitlisted" | "offered";  // Phase 18A
          attendance_status?: "attended" | "no_show" | null;
          offer_expires_at?: string | null;  // Phase 18A
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          event_id?: string;
          profile_id?: string;
          role?: "host" | "participant";
          status?: "confirmed" | "cancelled" | "waitlisted" | "offered";  // Phase 18A
          attendance_status?: "attended" | "no_show" | null;
          offer_expires_at?: string | null;  // Phase 18A
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "event_participants_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "event_participants_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      notifications: {
        Row: {
          id:         string;
          club_id:    string;
          user_id:    string;
          kind:       "reservation_confirmed" | "reservation_cancelled_by_admin" | "reservation_cancelled_by_member" | "event_cancelled" | "event_joined" | "waitlist_promoted" | "waitlist_offer" | "announcement";  // Phase 18A: waitlist_offer
          body:       string;
          is_read:    boolean;
          metadata:   Json | null;
          created_at: string;
        };
        Insert: {
          id?:         string;
          club_id:     string;
          user_id:     string;
          kind:        "reservation_confirmed" | "reservation_cancelled_by_admin" | "reservation_cancelled_by_member" | "event_cancelled" | "event_joined" | "waitlist_promoted" | "waitlist_offer" | "announcement";  // Phase 18A: aligned with Row
          body:        string;
          is_read?:    boolean;
          metadata?:   Json | null;
          created_at?: string;
        };
        Update: {
          id?:         string;
          club_id?:    string;
          user_id?:    string;
          kind?:       "reservation_confirmed" | "reservation_cancelled_by_admin" | "reservation_cancelled_by_member" | "event_cancelled" | "event_joined" | "waitlist_promoted" | "waitlist_offer" | "announcement";  // Phase 18A: aligned with Row
          body?:       string;
          is_read?:    boolean;
          metadata?:   Json | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notifications_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      notification_deliveries: {
        Row: {
          id:                  string;
          notification_id:     string;
          club_id:             string;
          channel:             "sms" | "email";
          status:              "sent" | "failed" | "opted_out" | "no_phone";
          provider:            string | null;
          provider_message_id: string | null;
          error:               string | null;
          created_at:          string;
          sent_at:             string | null;
        };
        Insert: {
          id?:                  string;
          notification_id:      string;
          club_id:              string;
          channel:              "sms" | "email";
          status:               "sent" | "failed" | "opted_out" | "no_phone";
          provider?:            string | null;
          provider_message_id?: string | null;
          error?:               string | null;
          created_at?:          string;
          sent_at?:             string | null;
        };
        Update: {
          id?:                  string;
          notification_id?:     string;
          club_id?:             string;
          channel?:             "sms" | "email";
          status?:              "sent" | "failed" | "opted_out" | "no_phone";
          provider?:            string | null;
          provider_message_id?: string | null;
          error?:               string | null;
          created_at?:          string;
          sent_at?:             string | null;
        };
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_notification_id_fkey";
            columns: ["notification_id"];
            isOneToOne: false;
            referencedRelation: "notifications";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notification_deliveries_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          }
        ];
      };
      notification_preferences: {
        Row: {
          id:         string;
          user_id:    string;
          club_id:    string;
          kind:       "reservation_confirmed" | "reservation_cancelled_by_member" | "event_joined" | "announcement";
          enabled:    boolean;
          updated_at: string;
        };
        Insert: {
          id?:         string;
          user_id:     string;
          club_id:     string;
          kind:        "reservation_confirmed" | "reservation_cancelled_by_member" | "event_joined" | "announcement";
          enabled?:    boolean;
          updated_at?: string;
        };
        Update: {
          id?:         string;
          user_id?:    string;
          club_id?:    string;
          kind?:       "reservation_confirmed" | "reservation_cancelled_by_member" | "event_joined" | "announcement";
          enabled?:    boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notification_preferences_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notification_preferences_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          }
        ];
      };
      club_invites: {
        Row: {
          id:          string;
          club_id:     string;
          code:        string;
          role:        "member" | "pro" | "admin";
          email:       string | null;
          created_by:  string;
          expires_at:  string;
          accepted_at: string | null;
          accepted_by: string | null;
          revoked_at:  string | null;
          created_at:  string;
        };
        Insert: {
          id?:         string;
          club_id:     string;
          code?:       string;
          role?:       "member" | "pro" | "admin";
          email?:      string | null;
          created_by:  string;
          expires_at?: string;
          accepted_at?: string | null;
          accepted_by?: string | null;
          revoked_at?:  string | null;
          created_at?:  string;
        };
        Update: {
          id?:         string;
          club_id?:    string;
          code?:       string;
          role?:       "member" | "pro" | "admin";
          email?:      string | null;
          created_by?: string;
          expires_at?: string;
          accepted_at?: string | null;
          accepted_by?: string | null;
          revoked_at?:  string | null;
          created_at?:  string;
        };
        Relationships: [
          {
            foreignKeyName: "club_invites_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          }
        ];
      };
      roster_members: {
        Row: {
          id:         string;
          club_id:    string;
          first_name: string;
          last_name:  string;
          email:      string | null;
          phone:      string | null;
          role:       "member" | "pro" | "admin";  // display/intent only — does not grant permissions
          notes:      string | null;
          claimed_by: string | null;
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?:         string;
          club_id:     string;
          first_name:  string;
          last_name:   string;
          email?:      string | null;
          phone?:      string | null;
          role?:       "member" | "pro" | "admin";
          notes?:      string | null;
          claimed_by?: string | null;
          created_by:  string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?:         string;
          club_id?:    string;
          first_name?: string;
          last_name?:  string;
          email?:      string | null;
          phone?:      string | null;
          role?:       "member" | "pro" | "admin";
          notes?:      string | null;
          claimed_by?: string | null;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "roster_members_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          }
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      current_user_role: {
        Args: Record<string, never>;
        Returns: string;
      };
      current_user_club_id: {
        Args: Record<string, never>;
        Returns: string;
      };
      create_reservation: {
        Args: {
          p_court_id: string;
          p_starts_at: string;
          p_ends_at: string;
          p_format?: string | null;
          p_player_count?: number | null;
          p_guest_names?: string[] | null;
          p_notes?: string | null;
        };
        Returns: {
          id: string;
          club_id: string;
          court_id: string;
          owner_user_id: string;
          starts_at: string;
          ends_at: string;
          status: string;
          reason: string;
          player_count: number | null;
          format: string | null;
          guest_names: string[] | null;
          notes: string | null;
          event_id: string | null;
          created_by: string;
          created_at: string;
          updated_at: string;
          cancelled_at: string | null;
          cancelled_by: string | null;
          cancellation_kind: string | null;
        };
      };
      create_event: {
        Args: {
          p_event_type_id: string;
          p_title: string;
          p_starts_at: string;
          p_ends_at: string;
          p_court_ids: string[];
          p_description?: string | null;
          p_capacity?: number | null;
          p_notes?: string | null;
        };
        Returns: {
          id: string;
          club_id: string;
          event_type_id: string;
          title: string;
          description: string | null;
          starts_at: string;
          ends_at: string;
          capacity: number;
          court_count: number;
          status: string;
          created_by: string;
          created_at: string;
          updated_at: string;
        };
      };
      join_event: {
        Args: { p_event_id: string };
        Returns: {
          id: string;
          event_id: string;
          profile_id: string;
          role: string;
          status: string;
          attendance_status: string | null;
          offer_expires_at: string | null;  // Phase 18A
          created_at: string;
          updated_at: string;
        };
      };
      leave_event: {
        Args: { p_event_id: string };
        Returns: string | null;  // offered profile_id or null (Phase 18A: was promoted profile_id)
      };
      // Phase 18A: new RPCs
      accept_waitlist_offer: {
        Args: { p_event_id: string };
        Returns: {
          id: string;
          event_id: string;
          profile_id: string;
          role: string;
          status: string;
          attendance_status: string | null;
          offer_expires_at: string | null;
          created_at: string;
          updated_at: string;
        };
      };
      decline_waitlist_offer: {
        Args: { p_event_id: string };
        Returns: string | null;  // next offered profile_id or null
      };
      create_maintenance_block: {
        Args: {
          p_court_id:  string;
          p_starts_at: string;
          p_ends_at:   string;
          p_notes?:    string | null;
        };
        Returns: {
          id: string;
          club_id: string;
          court_id: string;
          owner_user_id: string;
          starts_at: string;
          ends_at: string;
          status: string;
          reason: string;
          player_count: number | null;
          format: string | null;
          guest_names: string[] | null;
          notes: string | null;
          event_id: string | null;
          created_by: string;
          created_at: string;
          updated_at: string;
          cancelled_at: string | null;
          cancelled_by: string | null;
          cancellation_kind: string | null;
        };
      };
      cancel_event: {
        Args: { p_event_id: string };
        Returns: {
          id: string;
          club_id: string;
          event_type_id: string;
          title: string;
          description: string | null;
          starts_at: string;
          ends_at: string;
          capacity: number;
          court_count: number;
          status: string;
          created_by: string;
          created_at: string;
          updated_at: string;
        };
      };
      admin_cancel_reservation: {
        Args: { p_reservation_id: string };
        Returns: {
          id: string;
          club_id: string;
          court_id: string;
          owner_user_id: string;
          starts_at: string;
          ends_at: string;
          status: string;
          reason: string;
          player_count: number | null;
          format: string | null;
          guest_names: string[] | null;
          notes: string | null;
          event_id: string | null;
          created_by: string;
          created_at: string;
          updated_at: string;
          cancelled_at: string | null;
          cancelled_by: string | null;
          cancellation_kind: string | null;
        };
      };
      get_members: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          first_name: string | null;
          last_name: string | null;
          phone: string | null;
          role: string;
          status: string;
          created_at: string;
          email: string | null;
          admin_notes: string | null;
        }[];
      };
      update_club_settings: {
        Args: {
          p_booking_window_days:         number;
          p_cancellation_window_hours:   number;
          p_cancellation_grace_minutes?: number;
          p_waitlist_offer_window_hours?: number;  // Phase 18A
        };
        Returns: {
          id: string;
          club_id: string;
          booking_window_days: number;
          cancellation_window_hours: number;
          cancellation_grace_minutes: number;
          waitlist_offer_window_hours: number;  // Phase 18A
          created_at: string;
          updated_at: string;
        };
      };
      update_club_name: {
        Args: { p_name: string };
        Returns: undefined;
      };
      create_maintenance_blocks: {
        Args: {
          p_court_ids:             string[];
          p_starts_at:             string;
          p_ends_at:               string;
          p_notes?:                string | null;
          p_show_notes_to_members?: boolean;
        };
        Returns: undefined;
      };
      get_audit_log: {
        Args: {
          p_limit?: number;
          p_offset?: number;
        };
        Returns: {
          id: string;
          actor_name: string;
          action: string;
          target_type: string;
          target_id: string;
          metadata: Json | null;
          created_at: string;
        }[];
      };
      get_event_roster: {
        Args: { p_event_id: string };
        Returns: {
          profile_id:        string;
          display_name:      string;
          role:              string;  // 'host' | 'participant' | 'guest' (Phase 19A)
          status:            string;
          attendance_status: string | null;
          offer_expires_at:  string | null;  // Phase 18A: null for confirmed/waitlisted/guest
          waitlist_position: number | null;
          roster_member_id:  string | null;  // Phase 21I-C: non-null for roster-linked guests
        }[];
      };
      mark_attendance: {
        Args: {
          p_event_id:          string;
          p_profile_id:        string;
          p_attendance_status: string | null;
        };
        Returns: undefined;
      };
      update_sms_preference: {
        Args: {
          p_sms_opt_in: boolean;
          p_ip?:        string | null;
        };
        Returns: undefined;
      };
      record_delivery_attempt: {
        Args: {
          p_notification_id:      string;
          p_channel:              string;
          p_status:               string;
          p_provider?:            string | null;
          p_provider_message_id?: string | null;
          p_error?:               string | null;
          p_sent_at?:             string | null;
        };
        Returns: string;
      };
      update_club_theme: {
        Args: { p_theme_key: string };
        Returns: undefined;
      };
      update_club_timezone: {
        Args: { p_timezone: string };
        Returns: undefined;
      };
      create_event_type: {
        Args: { p_label: string; p_color: string };
        Returns: undefined;
      };
      update_event_type: {
        Args: { p_id: string; p_label: string; p_color: string };
        Returns: undefined;
      };
      set_event_type_active: {
        Args: { p_id: string; p_is_active: boolean };
        Returns: undefined;
      };
      set_event_member_joinable: {
        Args: { p_event_id: string; p_member_joinable: boolean };
        Returns: undefined;
      };
      delete_event_type: {
        Args: { p_id: string };
        Returns: undefined;
      };
      add_court: {
        Args: { p_name: string };
        Returns: undefined;
      };
      rename_court: {
        Args: { p_court_id: string; p_name: string };
        Returns: undefined;
      };
      reorder_courts: {
        Args: { p_court_order: string[] };
        Returns: undefined;
      };
      set_court_active: {
        Args: { p_court_id: string; p_is_active: boolean };
        Returns: undefined;
      };
      delete_court: {
        Args: { p_court_id: string };
        Returns: undefined;
      };
      validate_club_invite: {
        Args: { p_code: string };
        Returns: Json;
      };
      accept_club_invite: {
        Args: { p_code: string };
        Returns: Json;
      };
      create_club_invite: {
        Args: {
          p_role?:       string;
          p_email?:      string | null;
          p_expires_at?: string;
        };
        Returns: string;
      };
      revoke_club_invite: {
        Args: { p_code: string };
        Returns: undefined;
      };
      get_club_invites: {
        Args: Record<string, never>;
        Returns: {
          id:          string;
          code:        string;
          role:        string;
          email:       string | null;
          expires_at:  string;
          accepted_at: string | null;
          accepted_by: string | null;
          revoked_at:  string | null;
          created_at:  string;
        }[];
      };
      set_member_role: {
        Args: { p_target_user_id: string; p_new_role: string };
        Returns: undefined;
      };
      set_member_status: {
        Args: { p_target_user_id: string; p_new_status: string };
        Returns: undefined;
      };
      update_operating_hours: {
        Args: { p_hours: Json; p_dry_run?: boolean };
        Returns: Json;
      };
      notify_reservation_cancelled_by_member: {
        Args: { p_reservation_id: string };
        Returns: undefined;
      };
      send_announcement: {
        Args: { p_title: string; p_body: string };
        Returns: number;
      };
      update_notification_preference: {
        Args: { p_kind: string; p_enabled: boolean };
        Returns: undefined;
      };
      user_pref_enabled: {
        Args: { p_user_id: string; p_kind: string };
        Returns: boolean;
      };
      get_user_email_for_notification: {
        Args: { p_notification_id: string };
        Returns: string | null;
      };
      email_already_delivered: {
        Args: { p_notification_id: string };
        Returns: boolean;
      };
      upsert_operating_hours_override: {
        Args: {
          p_override_date: string;
          p_is_closed:     boolean;
          p_opens_at?:     string | null;
          p_closes_at?:    string | null;
          p_note?:         string | null;
          p_dry_run?:      boolean;
        };
        Returns: Json;
      };
      delete_operating_hours_override: {
        Args: {
          p_override_date: string;
          p_dry_run?:      boolean;
        };
        Returns: Json;
      };
      // Phase 19B: admin participant action RPCs
      admin_add_member: {
        Args: { p_event_id: string; p_profile_id: string };
        Returns: {
          id:                string;
          event_id:          string;
          profile_id:        string;
          role:              string;
          status:            string;
          attendance_status: string | null;
          offer_expires_at:  string | null;
          created_at:        string;
          updated_at:        string;
        };
      };
      admin_remove_participant: {
        Args: { p_event_id: string; p_profile_id: string };
        Returns: undefined;
      };
      admin_force_confirm: {
        Args: { p_event_id: string; p_profile_id: string };
        Returns: {
          id:                string;
          event_id:          string;
          profile_id:        string;
          role:              string;
          status:            string;
          attendance_status: string | null;
          offer_expires_at:  string | null;
          created_at:        string;
          updated_at:        string;
        };
      };
      admin_offer_spot: {
        Args: { p_event_id: string; p_profile_id: string };
        Returns: {
          id:                string;
          event_id:          string;
          profile_id:        string;
          role:              string;
          status:            string;
          attendance_status: string | null;
          offer_expires_at:  string | null;
          created_at:        string;
          updated_at:        string;
        };
      };
      admin_expire_offer: {
        Args: { p_event_id: string; p_profile_id: string };
        Returns: undefined;
      };
      admin_add_guest: {
        Args: { p_event_id: string; p_display_name: string };
        Returns: {
          id:           string;
          event_id:     string;
          display_name: string;
          added_by:     string;
          created_at:   string;
        };
      };
      admin_remove_guest: {
        Args: { p_event_id: string; p_guest_id: string };
        Returns: undefined;
      };
      // Phase 21I-A: roster member RPCs
      get_roster_members: {
        Args: Record<string, never>;
        Returns: {
          id:         string;
          first_name: string;
          last_name:  string;
          email:      string | null;
          phone:      string | null;
          role:       string;
          notes:      string | null;
          created_by: string;
          created_at: string;
        }[];
      };
      add_roster_member: {
        Args: {
          p_first_name: string;
          p_last_name:  string;
          p_email?:     string | null;
          p_phone?:     string | null;
          p_role?:      string;
          p_notes?:     string | null;
        };
        Returns: string;  // new roster_member id
      };
      update_roster_member: {
        Args: {
          p_id:         string;
          p_first_name: string;
          p_last_name:  string;
          p_email?:     string | null;
          p_phone?:     string | null;
          p_role?:      string;
          p_notes?:     string | null;
        };
        Returns: undefined;
      };
      delete_roster_member: {
        Args: { p_id: string };
        Returns: undefined;
      };
      // Phase 21I-C-A: member notes + roster members in events
      set_member_notes: {
        Args: { p_target_user_id: string; p_notes: string | null };
        Returns: undefined;
      };
      admin_add_roster_member_to_event: {
        Args: { p_event_id: string; p_roster_member_id: string };
        Returns: {
          id:               string;
          event_id:         string;
          display_name:     string;
          added_by:         string;
          roster_member_id: string | null;
          created_at:       string;
        };
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
