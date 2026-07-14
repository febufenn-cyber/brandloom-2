import type { SupabaseClient, User } from '@supabase/supabase-js';

export type Env = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_API_BASE?: string;
  ANTHROPIC_API_VERSION?: string;
  WEB_ORIGIN?: string;
  PUBLIC_API_ORIGIN?: string;
  BETA_APP_ORIGIN?: string;
  WAITLIST_CONSENT_VERSION?: string;
  RATE_LIMIT_SALT?: string;
  TOKEN_ENCRYPTION_KEY: string;
  PUBLISHING_PROVIDER_MODE?: 'mock' | 'meta';
  CRON_SECRET?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_REDIRECT_URI?: string;
  META_OAUTH_AUTHORIZE_URL?: string;
  META_OAUTH_TOKEN_URL?: string;
  META_LONG_LIVED_TOKEN_URL?: string;
  META_REFRESH_TOKEN_URL?: string;
  META_GRAPH_BASE_URL?: string;
  META_REQUIRED_SCOPES?: string;
  META_OAUTH_USE_PKCE?: string;
  META_WEBHOOK_VERIFY_TOKEN?: string;
  BILLING_PROVIDER_MODE?: 'mock' | 'stripe';
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_API_BASE?: string;
  STRIPE_API_VERSION?: string;
  STRIPE_SUCCESS_URL?: string;
  STRIPE_CANCEL_URL?: string;
  DEPLOYMENT_ENVIRONMENT?: 'local' | 'staging' | 'production';
  APP_VERSION?: string;
  COMMIT_SHA?: string;
  EXPECTED_MIGRATION_VERSION?: string;
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
