import { z } from 'zod';

export const connectionStartSchema = z.object({
  return_to: z.string().max(500).default('#publishing'),
});

export const accountActivationSchema = z.object({
  is_default: z.boolean().default(true),
  publishing_enabled: z.boolean().default(true),
});

export const schedulePublicationSchema = z.object({
  platform_account_id: z.string().uuid(),
  scheduled_for: z.string().datetime({ offset: true }),
  brand_timezone: z.string().min(3).max(100).default('UTC'),
  local_scheduled_time: z.string().max(120).default(''),
});

export const reschedulePublicationSchema = z.object({
  scheduled_for: z.string().datetime({ offset: true }),
  brand_timezone: z.string().min(3).max(100),
  local_scheduled_time: z.string().max(120).default(''),
});

export const manualPublicationSchema = z.object({
  note: z.string().max(2000).default('Published manually outside Brandloom.'),
  remote_url: z.string().url().or(z.literal('')).default(''),
});

export const pausePublishingSchema = z.object({
  brand_id: z.string().uuid().nullable().optional(),
  platform_account_id: z.string().uuid().nullable().optional(),
  reason: z.string().min(3).max(1000),
});
