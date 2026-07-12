import type { Env } from '../types';
import { ProviderError, type OAuthToken, type ProviderCreation, type ProviderIdentity, type ProviderProcessing, type ProviderPublication, type ProviderSnapshot, type ProviderVerification, type PublishingProvider } from './types';

type Json = Record<string, unknown>;

function asString(value: unknown) { return typeof value === 'string' ? value : ''; }
function asNumber(value: unknown) { return typeof value === 'number' ? value : Number(value) || 0; }

export class MetaInstagramProvider implements PublishingProvider {
  readonly name = 'meta_instagram' as const;
  private readonly authorizeUrl: string;
  private readonly tokenUrl: string;
  private readonly graphBase: string;
  private readonly scopes: string[];

  constructor(private readonly env: Env) {
    this.authorizeUrl = env.META_OAUTH_AUTHORIZE_URL ?? 'https://www.instagram.com/oauth/authorize';
    this.tokenUrl = env.META_OAUTH_TOKEN_URL ?? 'https://api.instagram.com/oauth/access_token';
    this.graphBase = (env.META_GRAPH_BASE_URL ?? 'https://graph.instagram.com').replace(/\/$/, '');
    this.scopes = (env.META_REQUIRED_SCOPES ?? 'instagram_business_basic,instagram_business_content_publish')
      .split(',').map((scope) => scope.trim()).filter(Boolean);
  }

  private assertConfigured() {
    if (!this.env.META_APP_ID || !this.env.META_APP_SECRET || !this.env.META_REDIRECT_URI) {
      throw new ProviderError('Meta publishing is not configured.', 'authorization', 'CONFIGURATION');
    }
  }

  private async request(url: string, init: RequestInit, stage: string): Promise<Json> {
    try {
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => ({})) as Json;
      if (!response.ok) {
        const providerError = (payload.error ?? payload) as Json;
        const code = asString(providerError.code || providerError.error_code || response.status);
        const safeMessage = asString(providerError.message || providerError.error_message) || `Meta request failed during ${stage}.`;
        if (response.status === 429 || response.status >= 500) throw new ProviderError(safeMessage, 'transient', code);
        if (code === '190' || asString(providerError.type).toLowerCase().includes('oauth')) throw new ProviderError('Meta authorization is invalid or has been revoked.', 'authorization', code);
        throw new ProviderError(safeMessage, stage === 'create_media' ? 'content' : 'remote_rejection', code);
      }
      return payload;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`Meta could not be reached during ${stage}.`, 'transient', 'NETWORK', stage === 'publish');
    }
  }

  private graphUrl(path: string, params: Record<string, string> = {}) {
    const url = new URL(`${this.graphBase}/${path.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  buildAuthorizationUrl(input: { state: string; codeChallenge?: string }) {
    this.assertConfigured();
    const url = new URL(this.authorizeUrl);
    url.searchParams.set('client_id', this.env.META_APP_ID!);
    url.searchParams.set('redirect_uri', this.env.META_REDIRECT_URI!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.scopes.join(','));
    url.searchParams.set('state', input.state);
    if (input.codeChallenge && this.env.META_OAUTH_USE_PKCE !== 'false') {
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async exchangeCode(code: string, codeVerifier?: string): Promise<OAuthToken> {
    this.assertConfigured();
    const form = new URLSearchParams({
      client_id: this.env.META_APP_ID!,
      client_secret: this.env.META_APP_SECRET!,
      grant_type: 'authorization_code',
      redirect_uri: this.env.META_REDIRECT_URI!,
      code,
    });
    if (codeVerifier && this.env.META_OAUTH_USE_PKCE !== 'false') form.set('code_verifier', codeVerifier);
    const payload = await this.request(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    }, 'token_exchange');
    const accessToken = asString(payload.access_token);
    if (!accessToken) throw new ProviderError('Meta did not return an access token.', 'authorization', 'TOKEN_MISSING');
    return {
      accessToken,
      providerUserId: asString(payload.user_id),
      expiresIn: asNumber(payload.expires_in) || null,
      tokenType: asString(payload.token_type) || 'Bearer',
      scopes: this.scopes,
    };
  }

  async extendToken(token: OAuthToken): Promise<OAuthToken> {
    this.assertConfigured();
    const endpoint = this.env.META_LONG_LIVED_TOKEN_URL ?? `${this.graphBase}/access_token`;
    if (!endpoint) return token;
    const url = new URL(endpoint);
    url.searchParams.set('grant_type', 'ig_exchange_token');
    url.searchParams.set('client_secret', this.env.META_APP_SECRET!);
    url.searchParams.set('access_token', token.accessToken);
    try {
      const payload = await this.request(url.toString(), { method: 'GET' }, 'token_extension');
      return {
        ...token,
        accessToken: asString(payload.access_token) || token.accessToken,
        expiresIn: asNumber(payload.expires_in) || token.expiresIn,
        tokenType: asString(payload.token_type) || token.tokenType,
      };
    } catch (error) {
      if (error instanceof ProviderError && error.category !== 'authorization') return token;
      throw error;
    }
  }

  async refreshToken(token: string): Promise<OAuthToken> {
    const endpoint = this.env.META_REFRESH_TOKEN_URL ?? `${this.graphBase}/refresh_access_token`;
    const url = new URL(endpoint);
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', token);
    const payload = await this.request(url.toString(), { method: 'GET' }, 'token_refresh');
    return { accessToken: asString(payload.access_token) || token, expiresIn: asNumber(payload.expires_in) || null, tokenType: 'Bearer', scopes: this.scopes };
  }

  async inspectIdentity(accessToken: string): Promise<ProviderIdentity> {
    const payload = await this.request(this.graphUrl('me', {
      fields: 'id,user_id,username,name,account_type,profile_picture_url',
      access_token: accessToken,
    }), { method: 'GET' }, 'identity');
    const providerAccountId = asString(payload.user_id || payload.id);
    if (!providerAccountId) throw new ProviderError('Meta did not return a publishable account identity.', 'authorization', 'ACCOUNT_MISSING');
    return {
      providerAccountId,
      providerUserId: asString(payload.id || payload.user_id),
      username: asString(payload.username),
      displayName: asString(payload.name || payload.username),
      profileImageUrl: asString(payload.profile_picture_url),
      accountType: asString(payload.account_type),
      capabilities: { image_post: true, carousel: true, reel: true, story: false, max_carousel_items: 10 },
    };
  }

  async validateConnection(accessToken: string) {
    const identity = await this.inspectIdentity(accessToken);
    return { healthy: true, identity, scopes: this.scopes };
  }

  private async createSingle(accountId: string, accessToken: string, media: { url: string; mimeType: string }, caption: string, carouselItem = false, format?: string) {
    const body = new URLSearchParams({ access_token: accessToken });
    if (media.mimeType.startsWith('video/')) {
      body.set('video_url', media.url);
      body.set('media_type', format === 'reel' ? 'REELS' : 'VIDEO');
    } else body.set('image_url', media.url);
    if (caption) body.set('caption', caption);
    if (carouselItem) body.set('is_carousel_item', 'true');
    const payload = await this.request(this.graphUrl(`${accountId}/media`), { method: 'POST', body }, 'create_media');
    const id = asString(payload.id);
    if (!id) throw new ProviderError('Meta did not return a media container.', 'unknown_result', 'CONTAINER_MISSING', true);
    return id;
  }

  async createMedia(accountId: string, accessToken: string, snapshot: ProviderSnapshot): Promise<ProviderCreation> {
    if (snapshot.format === 'story') throw new ProviderError('Story publishing is disabled until the capability spike confirms support.', 'content', 'STORY_DISABLED');
    if (snapshot.format === 'carousel') {
      const childContainerIds: string[] = [];
      for (const media of snapshot.media) childContainerIds.push(await this.createSingle(accountId, accessToken, media, '', true));
      const body = new URLSearchParams({
        access_token: accessToken,
        media_type: 'CAROUSEL',
        children: childContainerIds.join(','),
        caption: snapshot.caption,
      });
      const payload = await this.request(this.graphUrl(`${accountId}/media`), { method: 'POST', body }, 'create_media');
      const containerId = asString(payload.id);
      if (!containerId) throw new ProviderError('Meta did not return a carousel container.', 'unknown_result', 'CONTAINER_MISSING', true);
      return { containerId, childContainerIds, processingRequired: true };
    }
    const containerId = await this.createSingle(accountId, accessToken, snapshot.media[0]!, snapshot.caption, false, snapshot.format);
    return { containerId, processingRequired: snapshot.format === 'reel' };
  }

  async checkProcessing(containerId: string, accessToken: string): Promise<ProviderProcessing> {
    const payload = await this.request(this.graphUrl(containerId, { fields: 'status_code,status', access_token: accessToken }), { method: 'GET' }, 'processing_status');
    const status = asString(payload.status_code || payload.status).toUpperCase();
    return { ready: ['FINISHED', 'PUBLISHED'].includes(status), failed: ['ERROR', 'EXPIRED'].includes(status), status: status || 'UNKNOWN' };
  }

  async publish(accountId: string, accessToken: string, containerId: string): Promise<ProviderPublication> {
    const payload = await this.request(this.graphUrl(`${accountId}/media_publish`), {
      method: 'POST', body: new URLSearchParams({ creation_id: containerId, access_token: accessToken }),
    }, 'publish');
    const mediaId = asString(payload.id);
    if (!mediaId) throw new ProviderError('Meta accepted the request without returning a media ID.', 'unknown_result', 'MEDIA_ID_MISSING', true);
    return { mediaId };
  }

  async verify(mediaId: string, accessToken: string): Promise<ProviderVerification> {
    const payload = await this.request(this.graphUrl(mediaId, {
      fields: 'id,permalink,timestamp,media_type,caption,username', access_token: accessToken,
    }), { method: 'GET' }, 'verification');
    return {
      verified: asString(payload.id) === mediaId,
      mediaId: asString(payload.id) || mediaId,
      permalink: asString(payload.permalink),
      publishedAt: asString(payload.timestamp) || null,
      remoteSnapshot: payload,
    };
  }

  async disconnect(accessToken: string) {
    try {
      await this.request(this.graphUrl('me/permissions', { access_token: accessToken }), { method: 'DELETE' }, 'disconnect');
    } catch (error) {
      if (error instanceof ProviderError && error.category === 'authorization') return;
      throw error;
    }
  }
}
