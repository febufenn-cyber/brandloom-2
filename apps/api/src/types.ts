import type { SupabaseClient, User } from '@supabase/supabase-js';

export type Env = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  WEB_ORIGIN?: string;
};

export type Variables = {
  user: User;
  token: string;
  supabase: SupabaseClient;
};

export type QualityFlag = {
  code: 'prohibited_phrase' | 'ai_cliche' | 'unsupported_claim' | 'duplicate_hook' | 'missing_specificity';
  severity: 'warning' | 'error';
  message: string;
  evidence?: string;
};
