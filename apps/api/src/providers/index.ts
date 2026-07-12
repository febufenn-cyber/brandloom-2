import type { Env } from '../types';
import { MetaInstagramProvider } from './meta';
import { MockPublishingProvider } from './mock';
import type { PublishingProvider } from './types';

export function publishingProvider(env: Env): PublishingProvider {
  return env.PUBLISHING_PROVIDER_MODE === 'meta'
    ? new MetaInstagramProvider(env)
    : new MockPublishingProvider();
}

export * from './types';
