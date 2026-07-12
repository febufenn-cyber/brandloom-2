import type { OAuthToken, ProviderCreation, ProviderIdentity, ProviderProcessing, ProviderPublication, ProviderSnapshot, ProviderVerification, PublishingProvider } from './types';

export class MockPublishingProvider implements PublishingProvider {
  readonly name = 'mock' as const;

  buildAuthorizationUrl(input: { state: string }) {
    return `/integrations/meta/callback?code=mock-code&state=${encodeURIComponent(input.state)}`;
  }

  async exchangeCode(): Promise<OAuthToken> {
    return { accessToken: 'mock-access-token', expiresIn: 60 * 60 * 24 * 60, providerUserId: 'mock-user', scopes: ['basic', 'content_publish'] };
  }

  async extendToken(token: OAuthToken) { return token; }
  async refreshToken(token: string): Promise<OAuthToken> { return { accessToken: token, expiresIn: 60 * 60 * 24 * 60 }; }

  async inspectIdentity(): Promise<ProviderIdentity> {
    return {
      providerAccountId: 'mock-instagram-account', providerUserId: 'mock-user', username: 'brandloom_demo',
      displayName: 'Brandloom Demo', profileImageUrl: '', accountType: 'BUSINESS',
      capabilities: { image_post: true, carousel: true, reel: true, story: false, max_carousel_items: 10 },
    };
  }

  async validateConnection() { return { healthy: true, identity: await this.inspectIdentity(), scopes: ['basic', 'content_publish'] }; }

  async createMedia(_accountId: string, _token: string, snapshot: ProviderSnapshot): Promise<ProviderCreation> {
    return { containerId: `mock-container-${crypto.randomUUID()}`, processingRequired: snapshot.format === 'reel', childContainerIds: snapshot.format === 'carousel' ? snapshot.media.map(() => `mock-child-${crypto.randomUUID()}`) : undefined };
  }

  async checkProcessing(): Promise<ProviderProcessing> { return { ready: true, failed: false, status: 'FINISHED' }; }
  async publish(): Promise<ProviderPublication> { return { mediaId: `mock-media-${crypto.randomUUID()}` }; }
  async verify(mediaId: string): Promise<ProviderVerification> { return { verified: true, mediaId, permalink: `https://example.invalid/${mediaId}`, publishedAt: new Date().toISOString(), remoteSnapshot: { id: mediaId, provider: 'mock' } }; }
  async disconnect(): Promise<void> {}
}
