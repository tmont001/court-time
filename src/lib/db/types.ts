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
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          timezone?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          timezone?: string;
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
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          club_id: string;
          booking_window_days?: number;
          cancellation_window_hours?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          club_id?: string;
          booking_window_days?: number;
          cancellation_window_hours?: number;
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
          club_id: string;
          first_name: string | null;
          last_name: string | null;
          phone: string | null;
          role: "member" | "pro" | "admin";
          status: "active" | "inactive" | "suspended";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          club_id: string;
          first_name?: string | null;
          last_name?: string | null;
          phone?: string | null;
          role?: "member" | "pro" | "admin";
          status?: "active" | "inactive" | "suspended";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          club_id?: string;
          first_name?: string | null;
          last_name?: string | null;
          phone?: string | null;
          role?: "member" | "pro" | "admin";
          status?: "active" | "inactive" | "suspended";
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
          key: "lesson" | "clinic" | "social" | "league" | "tournament";
          label: string;
          color: string;
          default_capacity: number;
          default_duration_minutes: number;
          default_court_count: number;
          shows_participant_names: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          club_id: string;
          key: "lesson" | "clinic" | "social" | "league" | "tournament";
          label: string;
          color: string;
          default_capacity: number;
          default_duration_minutes: number;
          default_court_count: number;
          shows_participant_names?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          club_id?: string;
          key?: "lesson" | "clinic" | "social" | "league" | "tournament";
          label?: string;
          color?: string;
          default_capacity?: number;
          default_duration_minutes?: number;
          default_court_count?: number;
          shows_participant_names?: boolean;
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
      event_participants: {
        Row: {
          id: string;
          event_id: string;
          profile_id: string;
          role: "host" | "participant";
          status: "confirmed" | "cancelled";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          event_id: string;
          profile_id: string;
          role?: "host" | "participant";
          status?: "confirmed" | "cancelled";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          event_id?: string;
          profile_id?: string;
          role?: "host" | "participant";
          status?: "confirmed" | "cancelled";
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
          created_at: string;
          updated_at: string;
        };
      };
      leave_event: {
        Args: { p_event_id: string };
        Returns: undefined;
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
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
