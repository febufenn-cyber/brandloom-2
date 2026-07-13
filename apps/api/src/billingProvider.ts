import type { Env } from './types';

export type CheckoutInput = {
  workspaceId: string;
  planCode: string;
  priceId: string;
  customerId?: string | null;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
};

export interface BillingProvider {
  createCheckout(input: CheckoutInput): Promise<{ id: string; url: string }>;
  createPortal(customerId: string, returnUrl: string): Promise<{ url: string }>;
}

async function stripePost(env: Env, path: string, params: URLSearchParams) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured.');
  const response = await fetch(`${env.STRIPE_API_BASE ?? 'https://api.stripe.com'}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(env.STRIPE_API_VERSION ? { 'Stripe-Version': env.STRIPE_API_VERSION } : {}),
    },
    body: params,
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const message = (data.error as { message?: string } | undefined)?.message ?? `Stripe request failed (${response.status}).`;
    throw new Error(message);
  }
  return data;
}

class StripeProvider implements BillingProvider {
  constructor(private readonly env: Env) {}

  async createCheckout(input: CheckoutInput) {
    const params = new URLSearchParams({
      mode: 'subscription',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.workspaceId,
      'line_items[0][price]': input.priceId,
      'line_items[0][quantity]': '1',
      'metadata[workspace_id]': input.workspaceId,
      'metadata[plan_code]': input.planCode,
      'subscription_data[metadata][workspace_id]': input.workspaceId,
      'subscription_data[metadata][plan_code]': input.planCode,
      allow_promotion_codes: 'true',
    });
    if (input.customerId) params.set('customer', input.customerId);
    else if (input.customerEmail) params.set('customer_email', input.customerEmail);
    const data = await stripePost(this.env, '/v1/checkout/sessions', params);
    if (typeof data.id !== 'string' || typeof data.url !== 'string') throw new Error('Stripe Checkout did not return a session URL.');
    return { id: data.id, url: data.url };
  }

  async createPortal(customerId: string, returnUrl: string) {
    const data = await stripePost(this.env, '/v1/billing_portal/sessions', new URLSearchParams({ customer: customerId, return_url: returnUrl }));
    if (typeof data.url !== 'string') throw new Error('Stripe portal did not return a URL.');
    return { url: data.url };
  }
}

export function billingProvider(env: Env): BillingProvider {
  if ((env.BILLING_PROVIDER_MODE ?? 'mock') !== 'stripe') throw new Error('The Stripe provider is disabled.');
  return new StripeProvider(env);
}
