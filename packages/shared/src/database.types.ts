// Generated Supabase types for the schema described by supabase/migrations/.
// Lives in @oct/shared (not supabase/) because backend's rootDir can't import
// files outside its workspace, and the frontend's direct RLS reads want the
// same types.
//
// Regenerate with:
//   npx supabase gen types typescript --project-id vmlxyqzjdaegkfylxfka \
//     > packages/shared/src/database.types.ts
// then re-add this header.
//
// Generated from prod on 2026-07-29, hand-amended with the two migrations prod
// had not yet applied at generation time: token_peaks (20260729120000) and
// oct_user_id_by_discord_id (20260726120000). Once those are applied, a plain
// regeneration should reproduce this file exactly — diff it to verify.

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
      contracts: {
        Row: {
          address: string
          author_id: string
          author_name: string
          chain: string
          channel_id: string
          channel_name: string
          created_at: string
          description: string | null
          enriched_at: string | null
          enrichment_source: string | null
          evm_chain: string | null
          fdv_at_call: number | null
          fdv_at_call_display: string | null
          first_seen: boolean
          guild_id: string | null
          guild_name: string | null
          id: string
          liquidity_display: string | null
          liquidity_usd: number | null
          message_id: string
          price_usd: number | null
          room_ids: string[]
          timestamp: string
          token_age: string | null
          token_name: string | null
          token_pair: string | null
          token_symbol: string | null
          user_id: string
          volume_display: string | null
          volume_usd: number | null
        }
        Insert: {
          address: string
          author_id: string
          author_name: string
          chain: string
          channel_id: string
          channel_name: string
          created_at?: string
          description?: string | null
          enriched_at?: string | null
          enrichment_source?: string | null
          evm_chain?: string | null
          fdv_at_call?: number | null
          fdv_at_call_display?: string | null
          first_seen?: boolean
          guild_id?: string | null
          guild_name?: string | null
          id?: string
          liquidity_display?: string | null
          liquidity_usd?: number | null
          message_id: string
          price_usd?: number | null
          room_ids?: string[]
          timestamp: string
          token_age?: string | null
          token_name?: string | null
          token_pair?: string | null
          token_symbol?: string | null
          user_id: string
          volume_display?: string | null
          volume_usd?: number | null
        }
        Update: {
          address?: string
          author_id?: string
          author_name?: string
          chain?: string
          channel_id?: string
          channel_name?: string
          created_at?: string
          description?: string | null
          enriched_at?: string | null
          enrichment_source?: string | null
          evm_chain?: string | null
          fdv_at_call?: number | null
          fdv_at_call_display?: string | null
          first_seen?: boolean
          guild_id?: string | null
          guild_name?: string | null
          id?: string
          liquidity_display?: string | null
          liquidity_usd?: number | null
          message_id?: string
          price_usd?: number | null
          room_ids?: string[]
          timestamp?: string
          token_age?: string | null
          token_name?: string | null
          token_pair?: string | null
          token_symbol?: string | null
          user_id?: string
          volume_display?: string | null
          volume_usd?: number | null
        }
        Relationships: []
      }
      discord_tokens: {
        Row: {
          created_at: string
          encrypted_token: string
          id: string
          position: number
          token_iv: string
          token_mask: string
          token_tag: string
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_token: string
          id?: string
          position?: number
          token_iv: string
          token_mask: string
          token_tag: string
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_token?: string
          id?: string
          position?: number
          token_iv?: string
          token_mask?: string
          token_tag?: string
          user_id?: string
        }
        Relationships: []
      }
      fomo_activity_cursors: {
        Row: {
          cursor_seeded: boolean
          fomo_user_id: string
          last_activity_id: string | null
          updated_at: string
        }
        Insert: {
          cursor_seeded?: boolean
          fomo_user_id: string
          last_activity_id?: string | null
          updated_at?: string
        }
        Update: {
          cursor_seeded?: boolean
          fomo_user_id?: string
          last_activity_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      fomo_poll_state: {
        Row: {
          id: boolean
          last_polled_at: string | null
          last_trade_id: string | null
          refresh_token: string | null
          updated_at: string
        }
        Insert: {
          id?: boolean
          last_polled_at?: string | null
          last_trade_id?: string | null
          refresh_token?: string | null
          updated_at?: string
        }
        Update: {
          id?: boolean
          last_polled_at?: string | null
          last_trade_id?: string | null
          refresh_token?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      fomo_tracked_users: {
        Row: {
          created_at: string
          display_name: string | null
          fomo_handle: string | null
          fomo_user_id: string
          id: string
          notify_pushover: boolean
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          fomo_handle?: string | null
          fomo_user_id: string
          id?: string
          notify_pushover?: boolean
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          fomo_handle?: string | null
          fomo_user_id?: string
          id?: string
          notify_pushover?: boolean
          user_id?: string
        }
        Relationships: []
      }
      fomo_trade_deliveries: {
        Row: {
          delivered_at: string
          id: string
          trade_event_id: string
          user_id: string
        }
        Insert: {
          delivered_at?: string
          id?: string
          trade_event_id: string
          user_id: string
        }
        Update: {
          delivered_at?: string
          id?: string
          trade_event_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fomo_trade_deliveries_trade_event_id_fkey"
            columns: ["trade_event_id"]
            isOneToOne: false
            referencedRelation: "fomo_trade_events"
            referencedColumns: ["id"]
          },
        ]
      }
      fomo_trade_events: {
        Row: {
          created_at: string
          fomo_handle: string | null
          fomo_user_id: string
          id: string
          network_id: number | null
          raw: Json | null
          side: string | null
          token_address: string | null
          token_symbol: string | null
          trade_id: string | null
          usd_value: number | null
        }
        Insert: {
          created_at?: string
          fomo_handle?: string | null
          fomo_user_id: string
          id?: string
          network_id?: number | null
          raw?: Json | null
          side?: string | null
          token_address?: string | null
          token_symbol?: string | null
          trade_id?: string | null
          usd_value?: number | null
        }
        Update: {
          created_at?: string
          fomo_handle?: string | null
          fomo_user_id?: string
          id?: string
          network_id?: number | null
          raw?: Json | null
          side?: string | null
          token_address?: string | null
          token_symbol?: string | null
          trade_id?: string | null
          usd_value?: number | null
        }
        Relationships: []
      }
      highlighted_users: {
        Row: {
          color: string | null
          created_at: string
          id: string
          match_type: string
          room_id: string | null
          user_id: string
          value: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          match_type?: string
          room_id?: string | null
          user_id: string
          value: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          match_type?: string
          room_id?: string | null
          user_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "highlighted_users_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      keywords: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          label: string | null
          match_mode: string
          pattern: string
          room_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          label?: string | null
          match_mode?: string
          pattern: string
          room_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          label?: string | null
          match_mode?: string
          pattern?: string
          room_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "keywords_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lp_automation_policies: {
        Row: {
          allowed_pools: string[]
          chain: string
          created_at: string
          daily_spend_cap_usd: number
          id: string
          is_active: boolean
          max_il_risk_score: number
          max_interval_hours: number
          max_position_size_usd: number
          min_24h_volume_usd: number
          min_efficiency_delta_percent: number
          min_fees_vs_gas_ratio: number
          min_tvl_usd: number
          range_exit_percent: number
          sustained_duration_minutes: number
          user_id: string
          version: number
        }
        Insert: {
          allowed_pools?: string[]
          chain: string
          created_at?: string
          daily_spend_cap_usd: number
          id?: string
          is_active?: boolean
          max_il_risk_score: number
          max_interval_hours: number
          max_position_size_usd: number
          min_24h_volume_usd: number
          min_efficiency_delta_percent: number
          min_fees_vs_gas_ratio: number
          min_tvl_usd: number
          range_exit_percent: number
          sustained_duration_minutes: number
          user_id: string
          version: number
        }
        Update: {
          allowed_pools?: string[]
          chain?: string
          created_at?: string
          daily_spend_cap_usd?: number
          id?: string
          is_active?: boolean
          max_il_risk_score?: number
          max_interval_hours?: number
          max_position_size_usd?: number
          min_24h_volume_usd?: number
          min_efficiency_delta_percent?: number
          min_fees_vs_gas_ratio?: number
          min_tvl_usd?: number
          range_exit_percent?: number
          sustained_duration_minutes?: number
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      missed_runner_alerts: {
        Row: {
          channel_name: string | null
          cooldown_until: string
          id: string
          mc_at_call: number | null
          mc_now: number | null
          multiplier: number | null
          token_address: string
          token_symbol: string | null
          triggered_at: string
          user_id: string
        }
        Insert: {
          channel_name?: string | null
          cooldown_until: string
          id?: string
          mc_at_call?: number | null
          mc_now?: number | null
          multiplier?: number | null
          token_address: string
          token_symbol?: string | null
          triggered_at?: string
          user_id: string
        }
        Update: {
          channel_name?: string | null
          cooldown_until?: string
          id?: string
          mc_at_call?: number | null
          mc_now?: number | null
          multiplier?: number | null
          token_address?: string
          token_symbol?: string | null
          triggered_at?: string
          user_id?: string
        }
        Relationships: []
      }
      room_channels: {
        Row: {
          channel_id: string
          channel_name: string | null
          disable_embeds: boolean
          guild_id: string | null
          guild_name: string | null
          id: string
          room_id: string
          source: string
          user_id: string
        }
        Insert: {
          channel_id: string
          channel_name?: string | null
          disable_embeds?: boolean
          guild_id?: string | null
          guild_name?: string | null
          id?: string
          room_id: string
          source?: string
          user_id: string
        }
        Update: {
          channel_id?: string
          channel_name?: string | null
          disable_embeds?: boolean
          guild_id?: string | null
          guild_name?: string | null
          id?: string
          room_id?: string
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_channels_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      rooms: {
        Row: {
          color: string | null
          created_at: string
          filter_enabled: boolean
          filtered_users: string[]
          highlight_mode: string
          id: string
          name: string
          position: number
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          filter_enabled?: boolean
          filtered_users?: string[]
          highlight_mode?: string
          id?: string
          name: string
          position?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          filter_enabled?: boolean
          filtered_users?: string[]
          highlight_mode?: string
          id?: string
          name?: string
          position?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      telegram_credentials: {
        Row: {
          api_hash_iv: string
          api_hash_tag: string
          api_id_iv: string
          api_id_tag: string
          created_at: string
          encrypted_api_hash: string
          encrypted_api_id: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          api_hash_iv: string
          api_hash_tag: string
          api_id_iv: string
          api_id_tag: string
          created_at?: string
          encrypted_api_hash: string
          encrypted_api_id: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          api_hash_iv?: string
          api_hash_tag?: string
          api_id_iv?: string
          api_id_tag?: string
          created_at?: string
          encrypted_api_hash?: string
          encrypted_api_id?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      telegram_sessions: {
        Row: {
          created_at: string
          encrypted_session: string
          id: string
          position: number
          session_iv: string
          session_tag: string
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_session: string
          id?: string
          position?: number
          session_iv: string
          session_tag: string
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_session?: string
          id?: string
          position?: number
          session_iv?: string
          session_tag?: string
          user_id?: string
        }
        Relationships: []
      }
      token_catalog: {
        Row: {
          address: string
          chain: string
          confidence: string | null
          created_at: string
          enriched_at: string
          evm_chain: string
          fdv: number | null
          id: string
          liq: number | null
          name: string | null
          pair: string | null
          price_usd: number | null
          raw: Json | null
          source: string | null
          symbol: string | null
          updated_at: string
        }
        Insert: {
          address: string
          chain: string
          confidence?: string | null
          created_at?: string
          enriched_at?: string
          evm_chain?: string
          fdv?: number | null
          id?: string
          liq?: number | null
          name?: string | null
          pair?: string | null
          price_usd?: number | null
          raw?: Json | null
          source?: string | null
          symbol?: string | null
          updated_at?: string
        }
        Update: {
          address?: string
          chain?: string
          confidence?: string | null
          created_at?: string
          enriched_at?: string
          evm_chain?: string
          fdv?: number | null
          id?: string
          liq?: number | null
          name?: string | null
          pair?: string | null
          price_usd?: number | null
          raw?: Json | null
          source?: string | null
          symbol?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      token_peaks: {
        Row: {
          address: string
          chain: string
          created_at: string
          evm_chain: string | null
          id: string
          last_mc: number
          peak_at: string
          peak_mc: number
          updated_at: string
        }
        Insert: {
          address: string
          chain: string
          created_at?: string
          evm_chain?: string | null
          id?: string
          last_mc?: number
          peak_at?: string
          peak_mc?: number
          updated_at?: string
        }
        Update: {
          address?: string
          chain?: string
          created_at?: string
          evm_chain?: string | null
          id?: string
          last_mc?: number
          peak_at?: string
          peak_mc?: number
          updated_at?: string
        }
        Relationships: []
      }
      user_configs: {
        Row: {
          created_at: string
          id: string
          settings: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          settings?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          settings?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_holding_wallets: {
        Row: {
          address: string
          chain: string
          created_at: string
          id: string
          label: string
          updated_at: string
          user_id: string
        }
        Insert: {
          address: string
          chain: string
          created_at?: string
          id?: string
          label?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          address?: string
          chain?: string
          created_at?: string
          id?: string
          label?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_sounds: {
        Row: {
          channel_id: string | null
          created_at: string
          id: string
          sound_type: string
          storage_path: string
          user_id: string
        }
        Insert: {
          channel_id?: string | null
          created_at?: string
          id?: string
          sound_type: string
          storage_path: string
          user_id: string
        }
        Update: {
          channel_id?: string | null
          created_at?: string
          id?: string
          sound_type?: string
          storage_path?: string
          user_id?: string
        }
        Relationships: []
      }
      user_tracked_wallets: {
        Row: {
          address: string
          alerts_on_bubble: boolean
          alerts_on_feed: boolean
          alerts_on_toast: boolean
          chain: string
          created_at: string
          emoji: string
          id: string
          name: string
          profile: string
          sound: string
          updated_at: string
          user_id: string
        }
        Insert: {
          address: string
          alerts_on_bubble?: boolean
          alerts_on_feed?: boolean
          alerts_on_toast?: boolean
          chain: string
          created_at?: string
          emoji?: string
          id?: string
          name?: string
          profile?: string
          sound?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          address?: string
          alerts_on_bubble?: boolean
          alerts_on_feed?: boolean
          alerts_on_toast?: boolean
          chain?: string
          created_at?: string
          emoji?: string
          id?: string
          name?: string
          profile?: string
          sound?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      lp_append_policy: {
        Args: { p_policy: Json; p_user_id: string }
        Returns: {
          allowed_pools: string[]
          chain: string
          created_at: string
          daily_spend_cap_usd: number
          id: string
          is_active: boolean
          max_il_risk_score: number
          max_interval_hours: number
          max_position_size_usd: number
          min_24h_volume_usd: number
          min_efficiency_delta_percent: number
          min_fees_vs_gas_ratio: number
          min_tvl_usd: number
          range_exit_percent: number
          sustained_duration_minutes: number
          user_id: string
          version: number
        }
        SetofOptions: {
          from: "*"
          to: "lp_automation_policies"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      lp_is_pool_address_array: {
        Args: { p_pools: string[] }
        Returns: boolean
      }
      oct_user_id_by_discord_id: {
        Args: { p_discord_id: string }
        Returns: string
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
