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
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
