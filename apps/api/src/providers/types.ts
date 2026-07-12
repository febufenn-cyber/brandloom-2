export type OAuthToken = {
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string;
  expiresIn?: number | null;
  providerUserId?: string;
  scopes?: string[];
};

export type ProviderIdentity = {
  providerAccountId: string;
  providerUserId: string;
  username: string;
  displayName: string;
  profileImageUrl: string;
  accountType: string;
  capabilities: Record<string, boolean | number | null>;
};

export type ProviderMedia = {
  url: string;
  mimeType: string;
  role: string;
  position: number;
};

export type ProviderSnapshot = {
  format: 'static' | 'carousel' | 'reel' | 'story';
  caption: string;
  media: ProviderMedia[];
};

export type ProviderCreation = {
  containerId: string;
  childContainerIds?: string[];
  processingRequired: boolean;
};

export type ProviderProcessing = {
  ready: boolean;
  failed: boolean;
  status: string;
};

export type ProviderPublication = {
  mediaId: string;
};

export type ProviderVerification = {
  verified: boolean;
  mediaId: string;
  permalink: string;
  publishedAt?: string | null;
  remoteSnapshot: Record<string, unknown>;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly category: 'transient' | 'authorization' | 'content' | 'asset' | 'unknown_result' | 'remote_rejection',
    public readonly providerCode = '',
    public readonly unknownResult = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface PublishingProvider {
  readonly name: 'meta_instagram' | 'mock';
  buildAuthorizationUrl(input: { state: string; codeChallenge?: string }): string;
  exchangeCode(code: string, codeVerifier?: string): Promise<OAuthToken>;
  extendToken(token: OAuthToken): Promise<OAuthToken>;
  refreshToken(token: string): Promise<OAuthToken>;
  inspectIdentity(accessToken: string): Promise<ProviderIdentity>;
  validateConnection(accessToken: string): Promise<{ healthy: boolean; identity: ProviderIdentity; scopes: string[] }>;
  createMedia(accountId: string, accessToken: string, snapshot: ProviderSnapshot): Promise<ProviderCreation>;
  checkProcessing(containerId: string, accessToken: string): Promise<ProviderProcessing>;
  publish(accountId: string, accessToken: string, containerId: string): Promise<ProviderPublication>;
  verify(mediaId: string, accessToken: string): Promise<ProviderVerification>;
  disconnect(accessToken: string): Promise<void>;
}
