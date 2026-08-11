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
          is_lesson_provider: boolean;
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
          is_lesson_provider?: boolean;
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
          is_lesson_provider?: boolean;
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
          owner_user_id: string | null;
          roster_member_id: string | null;
          starts_at: string;
          ends_at: string;
          status: "pending" | "confirmed" | "cancelled";
          reason: "member_booking" | "maintenance" | "admin_block" | "event" | "pro_lesson";
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
          owner_user_id?: string | null;
          roster_member_id?: string | null;
          starts_at: string;
          ends_at: string;
          status?: "pending" | "confirmed" | "cancelled";
          reason?: "member_booking" | "maintenance" | "admin_block" | "event" | "pro_lesson";
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
          owner_user_id?: string | null;
          roster_member_id?: string | null;
          starts_at?: string;
          ends_at?: string;
          status?: "pending" | "confirmed" | "cancelled";
          reason?: "member_booking" | "maintenance" | "admin_block" | "event" | "pro_lesson";
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
            foreignKeyName: "reservations_roster_member_id_fkey";
            columns: ["roster_member_id"];
            isOneToOne: false;
            referencedRelation: "roster_members";
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
          program_id: string | null;              // Phase 27B1
          program_schedule_rule_id: string | null; // Phase 27B1
          program_occurrence_date: string | null;  // Phase 27B1
          is_program_exception: boolean;           // Phase 27B1
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
          program_id?: string | null;              // Phase 27B1
          program_schedule_rule_id?: string | null; // Phase 27B1
          program_occurrence_date?: string | null;  // Phase 27B1
          is_program_exception?: boolean;           // Phase 27B1
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
          program_id?: string | null;              // Phase 27B1
          program_schedule_rule_id?: string | null; // Phase 27B1
          program_occurrence_date?: string | null;  // Phase 27B1
          is_program_exception?: boolean;           // Phase 27B1
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
          },
          {
            foreignKeyName: "events_program_id_fkey";
            columns: ["program_id"];
            isOneToOne: false;
            referencedRelation: "programs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "events_program_rule_fkey";
            columns: ["program_schedule_rule_id", "program_id"];
            isOneToOne: false;
            referencedRelation: "program_schedule_rules";
            referencedColumns: ["id", "program_id"];
          }
        ];
      };
      programs: {
        Row: {
          id: string;
          club_id: string;
          event_type_id: string;
          title: string;
          description: string | null;
          enrollment_model: "program" | "per_session" | "admin_managed";
          status: "draft" | "active" | "cancelled" | "completed";
          starts_on: string;
          ends_on: string;
          default_capacity: number;
          created_by: string;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
          archived_by: string | null;
        };
        Insert: {
          id?: string;
          club_id: string;
          event_type_id: string;
          title: string;
          description?: string | null;
          enrollment_model: "program" | "per_session" | "admin_managed";
          status?: "draft" | "active" | "cancelled" | "completed";
          starts_on: string;
          ends_on: string;
          default_capacity: number;
          created_by: string;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
          archived_by?: string | null;
        };
        Update: {
          id?: string;
          club_id?: string;
          event_type_id?: string;
          title?: string;
          description?: string | null;
          enrollment_model?: "program" | "per_session" | "admin_managed";
          status?: "draft" | "active" | "cancelled" | "completed";
          starts_on?: string;
          ends_on?: string;
          default_capacity?: number;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
          archived_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "programs_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "programs_event_type_id_fkey";
            columns: ["event_type_id"];
            isOneToOne: false;
            referencedRelation: "event_types";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "programs_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      program_schedule_rules: {
        Row: {
          id: string;
          program_id: string;
          day_of_week: number;
          start_time: string;
          duration_minutes: number;
          capacity_override: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          program_id: string;
          day_of_week: number;
          start_time: string;
          duration_minutes: number;
          capacity_override?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          program_id?: string;
          day_of_week?: number;
          start_time?: string;
          duration_minutes?: number;
          capacity_override?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "program_schedule_rules_program_id_fkey";
            columns: ["program_id"];
            isOneToOne: false;
            referencedRelation: "programs";
            referencedColumns: ["id"];
          }
        ];
      };
      program_rule_courts: {
        Row: {
          id: string;
          program_schedule_rule_id: string;
          court_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          program_schedule_rule_id: string;
          court_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          program_schedule_rule_id?: string;
          court_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "program_rule_courts_program_schedule_rule_id_fkey";
            columns: ["program_schedule_rule_id"];
            isOneToOne: false;
            referencedRelation: "program_schedule_rules";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "program_rule_courts_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "courts";
            referencedColumns: ["id"];
          }
        ];
      };
      program_enrollments: {
        Row: {
          id: string;
          program_id: string;
          profile_id: string;
          status: "enrolled" | "waitlisted" | "offered" | "cancelled";
          offer_expires_at: string | null;
          waitlisted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          program_id: string;
          profile_id: string;
          status: "enrolled" | "waitlisted" | "offered" | "cancelled";
          offer_expires_at?: string | null;
          waitlisted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          program_id?: string;
          profile_id?: string;
          status?: "enrolled" | "waitlisted" | "offered" | "cancelled";
          offer_expires_at?: string | null;
          waitlisted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "program_enrollments_program_id_fkey";
            columns: ["program_id"];
            isOneToOne: false;
            referencedRelation: "programs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "program_enrollments_profile_id_fkey";
            columns: ["profile_id"];
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
          kind:       "reservation_confirmed" | "reservation_cancelled_by_admin" | "reservation_cancelled_by_member" | "reservation_rescheduled" | "event_cancelled" | "event_updated" | "event_joined" | "waitlist_promoted" | "waitlist_offer" | "announcement" | "lesson_request_received" | "lesson_request_proposed" | "lesson_request_confirmed" | "lesson_request_declined" | "lesson_cancelled" | "lesson_provider_reassigned" | "lesson_admin_requested";
          body:       string;
          is_read:    boolean;
          metadata:   Json | null;
          created_at: string;
        };
        Insert: {
          id?:         string;
          club_id:     string;
          user_id:     string;
          kind:        "reservation_confirmed" | "reservation_cancelled_by_admin" | "reservation_cancelled_by_member" | "reservation_rescheduled" | "event_cancelled" | "event_updated" | "event_joined" | "waitlist_promoted" | "waitlist_offer" | "announcement" | "lesson_request_received" | "lesson_request_proposed" | "lesson_request_confirmed" | "lesson_request_declined" | "lesson_cancelled" | "lesson_provider_reassigned" | "lesson_admin_requested";
          body:        string;
          is_read?:    boolean;
          metadata?:   Json | null;
          created_at?: string;
        };
        Update: {
          id?:         string;
          club_id?:    string;
          user_id?:    string;
          kind?:       "reservation_confirmed" | "reservation_cancelled_by_admin" | "reservation_cancelled_by_member" | "reservation_rescheduled" | "event_cancelled" | "event_updated" | "event_joined" | "waitlist_promoted" | "waitlist_offer" | "announcement" | "lesson_request_received" | "lesson_request_proposed" | "lesson_request_confirmed" | "lesson_request_declined" | "lesson_cancelled" | "lesson_provider_reassigned" | "lesson_admin_requested";
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
          kind:       "reservation_confirmed" | "reservation_cancelled_by_member" | "reservation_cancelled_by_admin" | "reservation_rescheduled" | "event_joined" | "event_cancelled" | "event_updated" | "waitlist_offer" | "waitlist_promoted" | "announcement" | "lesson_request_received" | "lesson_request_proposed" | "lesson_request_confirmed" | "lesson_request_declined" | "lesson_cancelled" | "lesson_provider_reassigned" | "lesson_admin_requested";
          enabled:    boolean;
          updated_at: string;
        };
        Insert: {
          id?:         string;
          user_id:     string;
          club_id:     string;
          kind:        "reservation_confirmed" | "reservation_cancelled_by_member" | "reservation_cancelled_by_admin" | "reservation_rescheduled" | "event_joined" | "event_cancelled" | "event_updated" | "waitlist_offer" | "waitlist_promoted" | "announcement" | "lesson_request_received" | "lesson_request_proposed" | "lesson_request_confirmed" | "lesson_request_declined" | "lesson_cancelled" | "lesson_provider_reassigned" | "lesson_admin_requested";
          enabled?:    boolean;
          updated_at?: string;
        };
        Update: {
          id?:         string;
          user_id?:    string;
          club_id?:    string;
          kind?:       "reservation_confirmed" | "reservation_cancelled_by_member" | "reservation_cancelled_by_admin" | "reservation_rescheduled" | "event_joined" | "event_cancelled" | "event_updated" | "waitlist_offer" | "waitlist_promoted" | "announcement" | "lesson_request_received" | "lesson_request_proposed" | "lesson_request_confirmed" | "lesson_request_declined" | "lesson_cancelled" | "lesson_provider_reassigned" | "lesson_admin_requested";
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
          id:                string;
          club_id:           string;
          code:              string;
          role:              "member" | "pro" | "admin";
          email:             string | null;
          roster_member_id:  string | null;
          created_by:        string;
          expires_at:        string;
          accepted_at:       string | null;
          accepted_by:       string | null;
          revoked_at:        string | null;
          created_at:        string;
        };
        Insert: {
          id?:               string;
          club_id:           string;
          code?:              string;
          role?:             "member" | "pro" | "admin";
          email?:             string | null;
          roster_member_id?: string | null;
          created_by:        string;
          expires_at?:       string;
          accepted_at?:      string | null;
          accepted_by?:      string | null;
          revoked_at?:       string | null;
          created_at?:       string;
        };
        Update: {
          id?:               string;
          club_id?:          string;
          code?:             string;
          role?:             "member" | "pro" | "admin";
          email?:            string | null;
          roster_member_id?: string | null;
          created_by?:       string;
          expires_at?:       string;
          accepted_at?:      string | null;
          accepted_by?:      string | null;
          revoked_at?:       string | null;
          created_at?:       string;
        };
        Relationships: [
          {
            foreignKeyName: "club_invites_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "club_invites_roster_member_id_fkey";
            columns: ["roster_member_id"];
            isOneToOne: false;
            referencedRelation: "roster_members";
            referencedColumns: ["id"];
          }
        ];
      };
      lesson_requests: {
        Row: {
          id:                    string;
          club_id:               string;
          member_id:             string;
          pro_id:                string;
          preferred_court_id:    string | null;
          duration_minutes:      number;
          member_note:           string | null;
          preferred_windows:     Json | null;
          proposed_starts_at:    string | null;
          proposed_ends_at:      string | null;
          proposed_court_id:     string | null;
          status:                "pending" | "proposed" | "confirmed" | "declined" | "withdrawn" | "cancelled";
          decline_reason:        string | null;
          cancellation_reason:   string | null;
          last_actor_id:         string | null;
          last_actor_role:       "member" | "pro" | "admin" | null;
          linked_reservation_id: string | null;
          created_at:            string;
          updated_at:            string;
          confirmed_at:          string | null;
          declined_at:           string | null;
          cancelled_at:          string | null;
          cancelled_by:          string | null;
        };
        Insert: {
          id?:                    string;
          club_id:                string;
          member_id:              string;
          pro_id:                 string;
          preferred_court_id?:    string | null;
          duration_minutes:       number;
          member_note?:           string | null;
          preferred_windows?:     Json | null;
          proposed_starts_at?:    string | null;
          proposed_ends_at?:      string | null;
          proposed_court_id?:     string | null;
          status?:                "pending" | "proposed" | "confirmed" | "declined" | "withdrawn" | "cancelled";
          decline_reason?:        string | null;
          cancellation_reason?:   string | null;
          last_actor_id?:         string | null;
          last_actor_role?:       "member" | "pro" | "admin" | null;
          linked_reservation_id?: string | null;
          created_at?:            string;
          updated_at?:            string;
          confirmed_at?:          string | null;
          declined_at?:           string | null;
          cancelled_at?:          string | null;
          cancelled_by?:          string | null;
        };
        Update: {
          id?:                    string;
          club_id?:               string;
          member_id?:             string;
          pro_id?:                string;
          preferred_court_id?:    string | null;
          duration_minutes?:      number;
          member_note?:           string | null;
          preferred_windows?:     Json | null;
          proposed_starts_at?:    string | null;
          proposed_ends_at?:      string | null;
          proposed_court_id?:     string | null;
          status?:                "pending" | "proposed" | "confirmed" | "declined" | "withdrawn" | "cancelled";
          decline_reason?:        string | null;
          cancellation_reason?:   string | null;
          last_actor_id?:         string | null;
          last_actor_role?:       "member" | "pro" | "admin" | null;
          linked_reservation_id?: string | null;
          created_at?:            string;
          updated_at?:            string;
          confirmed_at?:          string | null;
          declined_at?:           string | null;
          cancelled_at?:          string | null;
          cancelled_by?:          string | null;
        };
        Relationships: [
          {
            foreignKeyName: "lesson_requests_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lesson_requests_member_id_fkey";
            columns: ["member_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lesson_requests_pro_id_fkey";
            columns: ["pro_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lesson_requests_linked_reservation_id_fkey";
            columns: ["linked_reservation_id"];
            isOneToOne: false;
            referencedRelation: "reservations";
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
      // Phase 24A
      member_notes: {
        Row: {
          id:                   string;
          club_id:              string;
          member_id:            string;
          author_id:            string;
          author_name_snapshot: string;
          content:              string;
          created_at:           string;
          updated_at:           string;
          archived_at:          string | null;
        };
        Insert: {
          id?:                   string;
          club_id:               string;
          member_id:             string;
          author_id:             string;
          author_name_snapshot:  string;
          content:               string;
          created_at?:           string;
          updated_at?:           string;
          archived_at?:          string | null;
        };
        Update: {
          id?:                   string;
          club_id?:              string;
          member_id?:            string;
          author_id?:            string;
          author_name_snapshot?: string;
          content?:              string;
          created_at?:           string;
          updated_at?:           string;
          archived_at?:          string | null;
        };
        Relationships: [
          {
            foreignKeyName: "member_notes_club_id_fkey";
            columns: ["club_id"];
            isOneToOne: false;
            referencedRelation: "clubs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "member_notes_member_id_fkey";
            columns: ["member_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "member_notes_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      pilot_inquiries: {
        Row: {
          id:                        string;
          created_at:                string;
          updated_at:                string;
          status:                    "new" | "contacted" | "qualified" | "closed";
          contact_name:              string;
          email:                     string;
          phone:                     string | null;
          preferred_contact_method:  "email" | "phone" | "either" | null;
          club_name:                 string;
          facility_type:             "private_club" | "country_club" | "hoa_residential" | "public_municipal" | "tennis_academy" | "school_university" | "other";
          facility_type_other:       string | null;
          website:                   string | null;
          court_count:               number;
          approximate_member_count:  number;
          current_process:           string;
          operational_challenge:     string;
          preferred_operating_model: "staff_managed" | "member_self_service" | "not_sure";
          additional_details:        string | null;
          source:                    string;
          request_fingerprint:       string | null;
        };
        Insert: {
          id?:                        string;
          created_at?:                string;
          updated_at?:                string;
          status?:                    "new" | "contacted" | "qualified" | "closed";
          contact_name:               string;
          email:                      string;
          phone?:                     string | null;
          preferred_contact_method?:  "email" | "phone" | "either" | null;
          club_name:                  string;
          facility_type:              "private_club" | "country_club" | "hoa_residential" | "public_municipal" | "tennis_academy" | "school_university" | "other";
          facility_type_other?:       string | null;
          website?:                   string | null;
          court_count:                number;
          approximate_member_count:   number;
          current_process:            string;
          operational_challenge:      string;
          preferred_operating_model:  "staff_managed" | "member_self_service" | "not_sure";
          additional_details?:        string | null;
          source?:                    string;
          request_fingerprint?:       string | null;
        };
        Update: {
          id?:                        string;
          created_at?:                string;
          updated_at?:                string;
          status?:                    "new" | "contacted" | "qualified" | "closed";
          contact_name?:              string;
          email?:                     string;
          phone?:                     string | null;
          preferred_contact_method?:  "email" | "phone" | "either" | null;
          club_name?:                 string;
          facility_type?:             "private_club" | "country_club" | "hoa_residential" | "public_municipal" | "tennis_academy" | "school_university" | "other";
          facility_type_other?:       string | null;
          website?:                   string | null;
          court_count?:               number;
          approximate_member_count?:  number;
          current_process?:           string;
          operational_challenge?:     string;
          preferred_operating_model?: "staff_managed" | "member_self_service" | "not_sure";
          additional_details?:        string | null;
          source?:                    string;
          request_fingerprint?:       string | null;
        };
        Relationships: [];
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
      current_user_roster_member_id: {
        Args: Record<string, never>;
        Returns: string | null;
      };
      current_user_is_lesson_provider: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      get_reporting_overview: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: {
          gross_utilization_pct: number;
          member_demand_utilization_pct: number;
          total_reservations: number;
          cancelled_reservations: number;
          cancellation_rate_pct: number;
          sessions_held: number;
          total_session_capacity: number;
          total_session_enrollment: number;
          session_fill_rate_pct: number;
          active_member_count: number;
          outstanding_waitlist_count: number;
        }[];
      };
      get_court_utilization: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: {
          court_id: string;
          court_name: string;
          available_hours: number;
          gross_reserved_hours: number;
          member_demand_reserved_hours: number;
          gross_utilization_pct: number;
          member_demand_utilization_pct: number;
        }[];
      };
      get_reservation_summary: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: {
          total_reservations: number;
          pending_reservations: number;
          confirmed_reservations: number;
          cancelled_reservations: number;
          cancellation_rate_pct: number;
          member_booking_count: number;
          event_count: number;
          pro_lesson_count: number;
          maintenance_count: number;
          admin_block_count: number;
          daily_series: { local_date: string; total_count: number; cancelled_count: number }[];
        }[];
      };
      get_event_program_summary: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: {
          standalone_sessions_held: number;
          program_sessions_held: number;
          total_sessions_held: number;
          total_capacity: number;
          confirmed_members: number;
          guests: number;
          total_enrollment: number;
          fill_rate_pct: number;
          attended_count: number;
          no_show_count: number;
          attendance_marked_count: number;
          attendance_rate_pct: number;
          no_show_rate_pct: number;
          cancelled_standalone_sessions: number;
          cancelled_program_sessions: number;
        }[];
      };
      get_waitlist_demand: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: {
          event_waitlisted_entries: number;
          event_live_offer_entries: number;
          program_waitlisted_entries: number;
          program_live_offer_entries: number;
          total_outstanding_entries: number;
        }[];
      };
      get_member_engagement_summary: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: {
          active_member_snapshot_count: number;
          engaged_member_count: number;
          members_with_reservations: number;
          members_with_event_participation: number;
          members_with_program_enrollment: number;
        }[];
      };
      set_active_club: {
        Args: { p_club_id: string };
        Returns: {
          club_id: string;
          role: string;
          status: string;
          is_lesson_provider: boolean;
        }[];
      };
      get_current_account_context: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          first_name: string | null;
          last_name: string | null;
          phone: string | null;
          created_at: string;
          updated_at: string;
          active_club_id: string | null;
          role: string | null;
          status: string | null;
          is_lesson_provider: boolean | null;
          club_name: string | null;
          club_slug: string | null;
          theme_key: string | null;
        }[];
      };
      // Phase 31D (migration 0104): profiles.sms_opt_in was never added to
      // the column-level SELECT grant established in
      // 0079_phase25_account_foundation.sql, so any raw client select
      // combining it with other columns (e.g. phone) is denied in full —
      // the root cause of the Phase 31D contact-resolution defect. This
      // SECURITY DEFINER RPC derives the caller solely from auth.uid(),
      // accepts no parameters, and returns only the caller's own phone/
      // sms_opt_in — never another user's row, never any other profile
      // field. Returns null if unauthenticated or (anomalously) no profile
      // row exists; callers must treat null as a failed lookup, not "no
      // phone."
      get_my_communication_settings: {
        Args: Record<string, never>;
        Returns: Json;
        // Runtime shape when non-null: { phone: string | null; sms_opt_in: boolean }
      };
      get_my_club_memberships: {
        Args: Record<string, never>;
        Returns: {
          club_id: string;
          club_name: string;
          club_slug: string;
          theme_key: string;
          role: string;
          is_lesson_provider: boolean;
          is_active_club: boolean;
        }[];
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
          owner_user_id: string | null;
          roster_member_id: string | null;
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
      admin_create_member_reservation: {
        Args: {
          p_court_id: string;
          p_starts_at: string;
          p_ends_at: string;
          p_roster_member_id: string;
          p_expected_club_id: string;
          p_format?: string | null;
          p_player_count?: number | null;
          p_guest_names?: string[] | null;
          p_notes?: string | null;
        };
        Returns: {
          id: string;
          club_id: string;
          court_id: string;
          owner_user_id: string | null;
          roster_member_id: string | null;
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
      // Phase 31C: exact-identity companion to leave_event, added in
      // migration 0102. Same business logic (shared internal
      // _leave_event_impl — not callable from the app), richer return.
      leave_event_v2: {
        Args: { p_event_id: string };
        Returns: {
          offered_profile_id: string | null;
          notification_id:    string | null;
        };
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
      // Phase 31C: cancel_event's return type changed in migration 0102 from
      // the raw `events` row to a jsonb bundle carrying the exact
      // {notification_id, user_id} pair for every confirmed/waitlisted/
      // offered participant notified — captured before any status mutation,
      // so it correctly includes previously-offered participants (fixed in
      // 0102's correction round). No app caller ever consumed the old raw
      // row shape (only `{ error }` was read), so this is a safe in-place
      // type update, not a new function.
      cancel_event: {
        Args: { p_event_id: string };
        Returns: Json;
        // Runtime shape: {
        //   event: { id, club_id, event_type_id, title, description,
        //            starts_at, ends_at, capacity, court_count, status,
        //            created_by, created_at, updated_at },
        //   notifications: Array<{ notification_id: string; user_id: string }>
        // }
      };
      // UNTOUCHED by migration 0102 — left byte-for-byte as-is for
      // app-deploy-window safety (adminCancelReservation still reads
      // `reservation.owner_user_id` off the raw return). Superseded by
      // admin_cancel_reservation_v2 below as of Phase 31C.
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
      // Phase 31C: exact-identity companion added in migration 0102. Same
      // mutation/audit/notification body as admin_cancel_reservation; adds
      // notification_id to the return so the caller never re-queries
      // notifications for it.
      admin_cancel_reservation_v2: {
        Args: { p_reservation_id: string };
        Returns: Json;
        // Runtime shape: {
        //   reservation: <reservations row, same shape as
        //     admin_cancel_reservation's Returns above>,
        //   notification_id: string | null
        // }
      };
      update_member_reservation: {
        Args: {
          p_reservation_id: string;
          p_expected_club_id: string;
          p_expected_updated_at: string;
          p_court_id: string;
          p_starts_at: string;
          p_ends_at: string;
          p_roster_member_id: string;
          p_format?: string | null;
          p_player_count?: number | null;
          p_guest_names?: string[] | null;
          p_notes?: string | null;
        };
        Returns: Json;
      };
      update_maintenance_block: {
        Args: {
          p_reservation_id: string;
          p_expected_club_id: string;
          p_expected_updated_at: string;
          p_court_id: string;
          p_starts_at: string;
          p_ends_at: string;
          p_notes?: string | null;
          p_show_notes_to_members?: boolean;
        };
        Returns: Json;
      };
      update_event: {
        Args: {
          p_event_id: string;
          p_expected_club_id: string;
          p_expected_updated_at: string;
          p_title: string;
          p_event_type_id: string;
          p_starts_at: string;
          p_ends_at: string;
          p_court_ids: string[];
          p_capacity: number;
          p_description?: string | null;
        };
        Returns: Json;
      };
      cancel_member_reservation: {
        Args: {
          p_reservation_id: string;
          p_expected_club_id: string;
        };
        Returns: Json;
      };
      get_members: {
        Args: Record<string, never>;
        Returns: {
          id:                 string;
          first_name:         string | null;
          last_name:          string | null;
          phone:              string | null;
          role:               string;
          status:             string;
          created_at:         string;
          email:              string | null;
          is_lesson_provider: boolean;
          removed_at:         string | null;
        }[];
      };
      remove_club_member: {
        Args: { p_target_user_id: string };
        Returns: undefined;
      };
      restore_club_member: {
        Args: { p_target_user_id: string };
        Returns: undefined;
      };
      set_lesson_provider_status: {
        Args: { p_target_user_id: string; p_enabled: boolean };
        Returns: undefined;
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
          p_role:              string;
          p_roster_member_id:  string;
          p_expires_at?:       string;
        };
        Returns: string;
      };
      resend_club_invite: {
        Args: {
          p_old_code:    string;
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
          id:               string;
          code:             string;
          role:             string;
          email:            string | null;
          expires_at:       string;
          accepted_at:      string | null;
          accepted_by:      string | null;
          revoked_at:       string | null;
          created_at:       string;
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
      // UNTOUCHED by migration 0102 — left byte-for-byte as-is for
      // app-deploy-window safety (sendAnnouncementAction still reads the
      // bare integer recipient count directly). Superseded by
      // send_announcement_v2 below as of Phase 31C.
      send_announcement: {
        Args: { p_title: string; p_body: string };
        Returns: number;
      };
      // Phase 31C: exact-identity companion added in migration 0102. Same
      // preference-filtered bulk-insert body as send_announcement; adds a
      // durable per-send batch id and the exact {notification_id, user_id}
      // set actually inserted.
      send_announcement_v2: {
        Args: { p_title: string; p_body: string };
        Returns: Json;
        // Runtime shape: {
        //   batch_id: string,
        //   recipient_count: number,
        //   notifications: Array<{ notification_id: string; user_id: string }>
        // }
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
      // Phase 31C: added in migration 0102. Domain-scoped, exact-identity
      // delivery-context RPCs — see supabase/migrations/0102 for full
      // authorization rules. Each returns null on any authorization
      // failure or wrong-domain kind rather than raising.
      get_reservation_delivery_context: {
        Args: { p_notification_id: string };
        Returns: Json;
        // Runtime shape when non-null: { notification_id, recipient_user_id,
        //   club_id, kind, body, metadata }
      };
      get_event_delivery_context: {
        Args: { p_notification_id: string };
        Returns: Json;
        // Runtime shape when non-null: { notification_id, recipient_user_id,
        //   club_id, kind, body, metadata }
      };
      get_waitlist_delivery_context: {
        Args: { p_notification_id: string };
        Returns: Json;
        // Runtime shape when non-null: { notification_id, recipient_user_id,
        //   club_id, kind, body, metadata }
      };
      get_waitlist_recipient_email: {
        Args: { p_notification_id: string };
        Returns: string | null;
      };
      get_waitlist_recipient_sms_contact: {
        Args: { p_notification_id: string };
        Returns: Json;
        // Runtime shape when non-null: { phone: string | null; sms_opt_in: boolean }
      };
      // Phase 31C (migration 0103): reservation/event SMS-reliability
      // correction. Authorization identical to get_reservation_delivery_
      // context / get_event_delivery_context respectively — see 0103 for
      // the full rule set. Replaces the raw profiles read previously used
      // for reservation/event SMS contact resolution, which two confirmed
      // local reproductions showed was not pilot-reliable.
      get_reservation_recipient_sms_contact: {
        Args: { p_notification_id: string };
        Returns: Json;
        // Runtime shape when non-null: { phone: string | null; sms_opt_in: boolean }
      };
      get_event_recipient_sms_contact: {
        Args: { p_notification_id: string };
        Returns: Json;
        // Runtime shape when non-null: { phone: string | null; sms_opt_in: boolean }
      };
      // Phase 31C (migration 0103): pilot-level best-effort SMS idempotency,
      // mirroring email_already_delivered's role for email. Unlike
      // email_already_delivered, this re-derives the notification's domain
      // (reservation/event/waitlist) from its own kind and applies that
      // domain's exact authorization rule before disclosing anything —
      // returns false for an unauthorized or cross-club caller, identical
      // to "not yet delivered".
      sms_already_delivered: {
        Args: { p_notification_id: string };
        Returns: boolean;
      };
      get_announcement_batch_delivery_context: {
        Args: { p_batch_id: string };
        Returns: {
          notification_id:   string;
          recipient_user_id: string;
          body:               string;
        }[];
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
      // Phase 27B2: program definition and session generation RPCs
      create_program: {
        Args: {
          p_event_type_id:    string;
          p_title:             string;
          p_enrollment_model:  "program" | "per_session" | "admin_managed";
          p_starts_on:         string;
          p_ends_on:           string;
          p_default_capacity:  number;
          p_rules:             Json;
          p_description?:      string | null;
        };
        Returns: {
          id:                string;
          club_id:           string;
          event_type_id:     string;
          title:             string;
          description:       string | null;
          enrollment_model:  "program" | "per_session" | "admin_managed";
          status:            "draft" | "active" | "cancelled" | "completed";
          starts_on:         string;
          ends_on:           string;
          default_capacity:  number;
          created_by:        string;
          created_at:        string;
          updated_at:        string;
          archived_at:       string | null;
          archived_by:       string | null;
        };
      };
      // Phase 27C.1: edit a draft program's definition
      update_program: {
        Args: {
          p_program_id:        string;
          p_event_type_id:     string;
          p_title:             string;
          p_enrollment_model:  "program" | "per_session" | "admin_managed";
          p_starts_on:         string;
          p_ends_on:           string;
          p_default_capacity:  number;
          p_rules:             Json;
          p_description?:      string | null;
        };
        Returns: {
          id:                string;
          club_id:           string;
          event_type_id:     string;
          title:             string;
          description:       string | null;
          enrollment_model:  "program" | "per_session" | "admin_managed";
          status:            "draft" | "active" | "cancelled" | "completed";
          starts_on:         string;
          ends_on:           string;
          default_capacity:  number;
          created_by:        string;
          created_at:        string;
          updated_at:        string;
          archived_at:       string | null;
          archived_by:       string | null;
        };
      };
      preview_program_sessions: {
        Args: {
          p_program_id:    string;
          p_from_date?:    string | null;
          p_through_date?: string | null;
        };
        Returns: {
          program_schedule_rule_id:  string;
          occurrence_date:            string;
          starts_at:                  string;
          ends_at:                    string;
          court_id:                   string;
          court_name:                 string;
          already_generated:          boolean;
          has_conflict:               boolean;
          conflicting_reservation_id: string | null;
          conflicting_event_id:       string | null;
          conflict_reason:            string | null;
        }[];
      };
      generate_program_sessions: {
        Args: {
          p_program_id:    string;
          p_from_date?:    string | null;
          p_through_date?: string | null;
        };
        Returns: {
          inserted_count: number;
          skipped_count:  number;
          event_ids:      string[];
        }[];
      };
      // Phase 27D1: whole-program enrollment state machine
      join_program: {
        Args: { p_program_id: string };
        Returns: {
          id:                string;
          program_id:        string;
          profile_id:        string;
          status:            "enrolled" | "waitlisted" | "offered" | "cancelled";
          offer_expires_at:  string | null;
          waitlisted_at:     string | null;
          created_at:        string;
          updated_at:        string;
        };
      };
      leave_program: {
        Args: { p_program_id: string };
        Returns: {
          id:                string;
          program_id:        string;
          profile_id:        string;
          status:            "enrolled" | "waitlisted" | "offered" | "cancelled";
          offer_expires_at:  string | null;
          waitlisted_at:     string | null;
          created_at:        string;
          updated_at:        string;
        };
      };
      accept_program_waitlist_offer: {
        Args: { p_program_id: string };
        Returns: {
          id:                string;
          program_id:        string;
          profile_id:        string;
          status:            "enrolled" | "waitlisted" | "offered" | "cancelled";
          offer_expires_at:  string | null;
          waitlisted_at:     string | null;
          created_at:        string;
          updated_at:        string;
        };
      };
      decline_program_waitlist_offer: {
        Args: { p_program_id: string };
        Returns: {
          id:                string;
          program_id:        string;
          profile_id:        string;
          status:            "enrolled" | "waitlisted" | "offered" | "cancelled";
          offer_expires_at:  string | null;
          waitlisted_at:     string | null;
          created_at:        string;
          updated_at:        string;
        };
      };
      // Phase 27D3A: admin/pro program roster management RPCs
      get_program_roster: {
        Args: { p_program_id: string };
        Returns: {
          enrollment_id:     string;
          program_id:        string;
          profile_id:        string;
          first_name:        string | null;
          last_name:         string | null;
          email:             string | null;
          status:            "enrolled" | "waitlisted" | "offered" | "cancelled";
          waitlisted_at:     string | null;
          offer_expires_at:  string | null;
          created_at:        string;
          updated_at:        string;
        }[];
      };
      add_program_member: {
        Args: { p_program_id: string; p_profile_id: string };
        Returns: {
          id:                string;
          program_id:        string;
          profile_id:        string;
          status:            "enrolled" | "waitlisted" | "offered" | "cancelled";
          offer_expires_at:  string | null;
          waitlisted_at:     string | null;
          created_at:        string;
          updated_at:        string;
        };
      };
      remove_program_member: {
        Args: { p_program_id: string; p_profile_id: string };
        Returns: {
          id:                string;
          program_id:        string;
          profile_id:        string;
          status:            "enrolled" | "waitlisted" | "offered" | "cancelled";
          offer_expires_at:  string | null;
          waitlisted_at:     string | null;
          created_at:        string;
          updated_at:        string;
        };
      };
      // Phase 27D3C: membership-native eligible-member lookup for the
      // program roster Add Member picker
      get_program_eligible_members: {
        Args: { p_program_id: string };
        Returns: {
          profile_id:    string;
          first_name:    string | null;
          last_name:     string | null;
          display_name:  string;
        }[];
      };
      // Phase 27E: program lifecycle RPCs
      cancel_program: {
        Args: { p_program_id: string };
        Returns: {
          id:                string;
          club_id:           string;
          event_type_id:     string;
          title:             string;
          description:       string | null;
          enrollment_model:  "program" | "per_session" | "admin_managed";
          status:            "draft" | "active" | "cancelled" | "completed";
          starts_on:         string;
          ends_on:           string;
          default_capacity:  number;
          created_by:        string;
          created_at:        string;
          updated_at:        string;
          archived_at:       string | null;
          archived_by:       string | null;
        };
      };
      complete_program: {
        Args: { p_program_id: string };
        Returns: {
          id:                string;
          club_id:           string;
          event_type_id:     string;
          title:             string;
          description:       string | null;
          enrollment_model:  "program" | "per_session" | "admin_managed";
          status:            "draft" | "active" | "cancelled" | "completed";
          starts_on:         string;
          ends_on:           string;
          default_capacity:  number;
          created_by:        string;
          created_at:        string;
          updated_at:        string;
          archived_at:       string | null;
          archived_by:       string | null;
        };
      };
      archive_program: {
        Args: { p_program_id: string };
        Returns: {
          id:                string;
          club_id:           string;
          event_type_id:     string;
          title:             string;
          description:       string | null;
          enrollment_model:  "program" | "per_session" | "admin_managed";
          status:            "draft" | "active" | "cancelled" | "completed";
          starts_on:         string;
          ends_on:           string;
          default_capacity:  number;
          created_by:        string;
          created_at:        string;
          updated_at:        string;
          archived_at:       string | null;
          archived_by:       string | null;
        };
      };
      unarchive_program: {
        Args: { p_program_id: string };
        Returns: {
          id:                string;
          club_id:           string;
          event_type_id:     string;
          title:             string;
          description:       string | null;
          enrollment_model:  "program" | "per_session" | "admin_managed";
          status:            "draft" | "active" | "cancelled" | "completed";
          starts_on:         string;
          ends_on:           string;
          default_capacity:  number;
          created_by:        string;
          created_at:        string;
          updated_at:        string;
          archived_at:       string | null;
          archived_by:       string | null;
        };
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
      // Phase 31C: return type changed in migration 0102 from the raw
      // `event_participants` row to a jsonb bundle carrying the exact
      // notification_id, with `triggered_by: auth.uid()` stamped into that
      // notification's metadata so a Pro actor (this RPC has always allowed
      // role in ('admin','pro')) can dispatch it without granting access to
      // any other, unrelated Pro. No app caller ever consumed the old raw
      // row shape (only `{ error }` was read), so this is a safe in-place
      // type update, not a new function.
      admin_force_confirm: {
        Args: { p_event_id: string; p_profile_id: string };
        Returns: Json;
        // Runtime shape: {
        //   participant: { id, event_id, profile_id, role, status,
        //     attendance_status, offer_expires_at, created_at, updated_at },
        //   notification_id: string
        // }
      };
      admin_offer_spot: {
        Args: { p_event_id: string; p_profile_id: string };
        Returns: Json;
        // Runtime shape: {
        //   participant: { id, event_id, profile_id, role, status,
        //     attendance_status, offer_expires_at, created_at, updated_at },
        //   notification_id: string
        // }
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
      // Migration 0067
      add_roster_member_and_invite: {
        Args: {
          p_first_name: string;
          p_last_name:  string;
          p_email:      string;
          p_role?:      string;
          p_phone?:     string | null;
          p_notes?:     string | null;
        };
        Returns: { roster_member_id: string; code: string };
      };
      get_club_pros: {
        Args: Record<string, never>;
        Returns: {
          id:                 string;
          first_name:         string | null;
          last_name:          string | null;
          role:               string;
          is_lesson_provider: boolean;
        }[];
      };
      // Phase 25C: admin-only provider list — includes calling admin when eligible
      get_admin_club_pros: {
        Args: Record<string, never>;
        Returns: {
          id:                 string;
          first_name:         string | null;
          last_name:          string | null;
          role:               string;
          is_lesson_provider: boolean;
        }[];
      };
      // Phase 24A: member CRM RPCs
      add_member_note: {
        Args: { p_member_id: string; p_content: string };
        Returns: {
          id:                   string;
          club_id:              string;
          member_id:            string;
          author_id:            string;
          author_name_snapshot: string;
          content:              string;
          created_at:           string;
          updated_at:           string;
          archived_at:          string | null;
        };
      };
      update_member_note: {
        Args: { p_note_id: string; p_content: string };
        Returns: undefined;
      };
      archive_member_note: {
        Args: { p_note_id: string };
        Returns: undefined;
      };
      get_member_notes: {
        Args: { p_member_id: string };
        Returns: {
          id:                   string;
          member_id:            string;
          author_id:            string;
          author_name_snapshot: string;
          content:              string;
          created_at:           string;
          updated_at:           string;
          archived_at:          string | null;
        }[];
      };
      get_admin_member_detail: {
        Args: { p_member_id: string };
        Returns: {
          id:                          string;
          first_name:                  string | null;
          last_name:                   string | null;
          phone:                       string | null;
          role:                        string;
          status:                      string;
          created_at:                  string;
          email:                       string | null;
          is_lesson_provider:          boolean;
          removed_at:                  string | null;
          attended_event_count:        number;
          event_no_show_count:         number;
          completed_lesson_count:      number;
          member_lesson_no_show_count: number;
        }[];
      };
      get_member_upcoming_activity: {
        Args: { p_member_id: string };
        Returns: {
          activity_id:         string;
          activity_type:       string;
          sort_ts:             string;
          status:              string;
          title:               string | null;
          starts_at:           string | null;
          ends_at:             string | null;
          court_name:          string | null;
          pro_first_name:      string | null;
          pro_last_name:       string | null;
          duration_minutes:    number | null;
          proposed_starts_at:  string | null;
          proposed_ends_at:    string | null;
          proposed_court_name: string | null;
        }[];
      };
      get_member_activity_history: {
        Args: {
          p_member_id:   string;
          p_cursor_ts?:  string | null;
          p_cursor_type?: string | null;
          p_cursor_id?:  string | null;
          p_limit?:      number;
        };
        Returns: {
          activity_id:       string;
          activity_type:     string;
          sort_ts:           string;
          status:            string;
          starts_at:         string | null;
          ends_at:           string | null;
          title:             string | null;
          attendance_status: string | null;
          pro_first_name:    string | null;
          pro_last_name:     string | null;
          duration_minutes:  number | null;
          lesson_outcome:    string | null;
        }[];
      };
      // Phase 24B: admin lesson ops
      reassign_lesson_provider: {
        Args: { p_request_id: string; p_new_pro_id: string };
        Returns: {
          id:                    string;
          club_id:               string;
          member_id:             string;
          pro_id:                string;
          preferred_court_id:    string | null;
          duration_minutes:      number;
          member_note:           string | null;
          preferred_windows:     Json | null;
          proposed_starts_at:    string | null;
          proposed_ends_at:      string | null;
          proposed_court_id:     string | null;
          status:                string;
          decline_reason:        string | null;
          cancellation_reason:   string | null;
          last_actor_id:         string | null;
          last_actor_role:       string | null;
          linked_reservation_id: string | null;
          created_at:            string;
          updated_at:            string;
          confirmed_at:          string | null;
          declined_at:           string | null;
          cancelled_at:          string | null;
          cancelled_by:          string | null;
        };
      };
      admin_create_lesson_request: {
        Args: {
          p_member_id:          string;
          p_pro_id:             string;
          p_duration_minutes:   number;
          p_lesson_type_id?:    string | null;
          p_preferred_court_id?: string | null;
          p_member_note?:       string | null;
          p_preferred_windows?: Json | null;
        };
        Returns: {
          id:                    string;
          club_id:               string;
          member_id:             string;
          pro_id:                string;
          preferred_court_id:    string | null;
          duration_minutes:      number;
          member_note:           string | null;
          preferred_windows:     Json | null;
          proposed_starts_at:    string | null;
          proposed_ends_at:      string | null;
          proposed_court_id:     string | null;
          status:                string;
          decline_reason:        string | null;
          cancellation_reason:   string | null;
          last_actor_id:         string | null;
          last_actor_role:       string | null;
          linked_reservation_id: string | null;
          created_at:            string;
          updated_at:            string;
          confirmed_at:          string | null;
          declined_at:           string | null;
          cancelled_at:          string | null;
          cancelled_by:          string | null;
        };
      };
      get_lesson_notification_id: {
        Args: { p_request_id: string; p_user_id: string; p_kind: string };
        Returns: Json | null;  // { id: string; body: string } | null
      };
      get_lesson_recipient_email: {
        Args: { p_request_id: string; p_user_id: string };
        Returns: string | null;
      };
      submit_lesson_request: {
        Args: {
          p_pro_id:              string;
          p_duration_minutes:    number;
          p_preferred_court_id?: string | null;
          p_member_note?:        string | null;
          p_preferred_windows?:  Json | null;
          p_lesson_type_id?:     string | null;
        };
        Returns: {
          id:                    string;
          club_id:               string;
          member_id:             string;
          pro_id:                string;
          preferred_court_id:    string | null;
          duration_minutes:      number;
          member_note:           string | null;
          preferred_windows:     Json | null;
          proposed_starts_at:    string | null;
          proposed_ends_at:      string | null;
          proposed_court_id:     string | null;
          status:                string;
          decline_reason:        string | null;
          cancellation_reason:   string | null;
          last_actor_id:         string | null;
          last_actor_role:       string | null;
          linked_reservation_id: string | null;
          created_at:            string;
          updated_at:            string;
          confirmed_at:          string | null;
          declined_at:           string | null;
          cancelled_at:          string | null;
          cancelled_by:          string | null;
        };
      };
      withdraw_lesson_request: {
        Args: { p_request_id: string };
        Returns: {
          id: string; status: string; updated_at: string;
        };
      };
      propose_lesson_time: {
        Args: {
          p_request_id:            string;
          p_expected_updated_at:   string;
          p_starts_at:             string;
          p_ends_at:               string;
          p_court_id?:             string | null;
        };
        Returns: {
          id: string; status: string; proposed_starts_at: string | null; proposed_ends_at: string | null; proposed_court_id: string | null; updated_at: string;
        };
      };
      accept_lesson_proposal: {
        Args: { p_request_id: string };
        Returns: Json;  // { request_id, reservation_id }
      };
      decline_lesson_proposal: {
        Args: { p_request_id: string };
        Returns: {
          id: string; status: string; updated_at: string;
        };
      };
      decline_lesson_request: {
        Args: {
          p_request_id: string;
          p_reason?:    string | null;
        };
        Returns: {
          id: string; status: string; decline_reason: string | null; declined_at: string | null; updated_at: string;
        };
      };
      cancel_lesson: {
        Args: {
          p_request_id: string;
          p_reason?:    string | null;
        };
        Returns: {
          id: string; status: string; cancellation_reason: string | null; cancelled_at: string | null; updated_at: string;
        };
      };
      get_my_lesson_requests: {
        Args: Record<string, never>;
        Returns: {
          id:                    string;
          pro_id:                string;
          pro_first_name:        string | null;
          pro_last_name:         string | null;
          preferred_court_id:    string | null;
          preferred_court_name:  string | null;
          duration_minutes:      number;
          member_note:           string | null;
          preferred_windows:     Json | null;
          proposed_starts_at:    string | null;
          proposed_ends_at:      string | null;
          proposed_court_id:     string | null;
          proposed_court_name:   string | null;
          status:                string;
          decline_reason:        string | null;
          cancellation_reason:   string | null;
          linked_reservation_id: string | null;
          created_at:            string;
          updated_at:            string;
          confirmed_at:          string | null;
          lesson_type_id:        string | null;
          lesson_type_name:      string | null;
          lesson_outcome:        string | null;
        }[];
      };
      get_pro_lesson_requests: {
        Args: {
          p_pro_filter?: string | null;
          p_status?:     string | null;
        };
        Returns: {
          id:                    string;
          member_id:             string;
          member_first_name:     string | null;
          member_last_name:      string | null;
          pro_id:                string;
          pro_first_name:        string | null;
          pro_last_name:         string | null;
          preferred_court_id:    string | null;
          preferred_court_name:  string | null;
          duration_minutes:      number;
          member_note:           string | null;
          preferred_windows:     Json | null;
          proposed_starts_at:    string | null;
          proposed_ends_at:      string | null;
          proposed_court_id:     string | null;
          proposed_court_name:   string | null;
          status:                string;
          decline_reason:        string | null;
          cancellation_reason:   string | null;
          last_actor_role:       string | null;
          linked_reservation_id: string | null;
          created_at:            string;
          updated_at:            string;
          confirmed_at:          string | null;
          lesson_type_id:        string | null;
          lesson_type_name:      string | null;
          lesson_outcome:        string | null;
        }[];
      };
      // Phase 23 competitive foundation RPCs (migration 0070)
      get_lesson_types: {
        Args: Record<string, never>;
        Returns: {
          id:                string;
          name:              string;
          description:       string | null;
          allowed_durations: number[] | null;
          max_participants:  number;
          rate_amount:       number | null;
          rate_currency:     string;
          rate_notes:        string | null;
          is_active:         boolean;
        }[];
      };
      upsert_lesson_type: {
        Args: {
          p_id?:                string | null;
          p_name?:              string | null;
          p_description?:       string | null;
          p_allowed_durations?: number[] | null;
          p_max_participants?:  number;
          p_rate_amount?:       number | null;
          p_rate_currency?:     string | null;
          p_rate_notes?:        string | null;
        };
        Returns: string;
      };
      archive_lesson_type: {
        Args: { p_type_id: string };
        Returns: undefined;
      };
      mark_lesson_outcome: {
        Args: { p_request_id: string; p_outcome: string };
        Returns: undefined;
      };
      get_pro_availability_windows: {
        Args: { p_pro_id?: string | null };
        Returns: {
          id:          string;
          pro_id:      string;
          day_of_week: number;
          start_time:  string;
          end_time:    string;
          is_active:   boolean;
        }[];
      };
      upsert_pro_availability_window: {
        Args: {
          p_day_of_week:  number;
          p_start_time:   string;
          p_end_time:     string;
          p_pro_id?:      string | null;
          p_window_id?:   string | null;
        };
        Returns: string;
      };
      delete_pro_availability_window: {
        Args: { p_window_id: string };
        Returns: undefined;
      };
      get_pro_blackouts: {
        Args: {
          p_pro_id?:    string | null;
          p_from_date?: string | null;
          p_to_date?:   string | null;
        };
        Returns: {
          id:            string;
          pro_id:        string;
          blackout_date: string;
          reason:        string | null;
          created_at:    string;
        }[];
      };
      upsert_pro_blackout: {
        Args: {
          p_blackout_date: string;
          p_reason?:       string | null;
          p_pro_id?:       string | null;
        };
        Returns: string;
      };
      delete_pro_blackout: {
        Args: { p_blackout_id: string };
        Returns: undefined;
      };
      submit_pilot_inquiry: {
        Args: {
          p_contact_name:              string;
          p_email:                     string;
          p_club_name:                 string;
          p_facility_type:             string;
          p_court_count:               number;
          p_approximate_member_count:  number;
          p_current_process:           string;
          p_operational_challenge:     string;
          p_preferred_operating_model: string;
          p_facility_type_other?:      string | null;
          p_phone?:                    string | null;
          p_preferred_contact_method?: string | null;
          p_website?:                  string | null;
          p_additional_details?:       string | null;
          p_source?:                   string | null;
          p_fingerprint?:              string | null;
        };
        Returns: { id: string; deduped: boolean }[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
