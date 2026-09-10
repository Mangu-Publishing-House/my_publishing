/**
 * Stripe Webhook Handler
 * Production-grade webhook processing with idempotency and retry logic
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { createClient as createAdminClient } from '@/lib/supabase/admin';
import { enforceRateLimit, getClientIdentifier } from '@/lib/rate-limit';
import { getStripe } from '@/lib/stripe/server';
import { sendPurchaseReceiptForCheckoutSession } from '@/lib/email/triggers';
import { isMongoPrimary } from '@/lib/db/provider';
import {
  upsertOrderByPaymentIntent,
  checkWebhookEventProcessed,
  recordWebhookEvent as recordWebhookEventMongo,
  markWebhookEventProcessed as markWebhookEventProcessedMongo,
} from '@/lib/mongo-queries';
import type { WebhookProcessingResult, CheckoutMetadata } from '@/types/webhook';

// Webhook secret for signature verification
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

/**
 * Verify Stripe webhook signature
 */
function verifySignature(
  payload: string,
  signature: string
): { valid: boolean; event?: Stripe.Event; error?: string } {
  try {
    const stripe = getStripe();
    const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    return { valid: true, event };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Webhook] Signature verification failed:', message);
    return { valid: false, error: message };
  }
}

/**
 * Check if event was already processed (idempotency)
 */
async function checkIdempotency(
  supabase: ReturnType<typeof createAdminClient>,
  eventId: string
): Promise<{ processed: boolean; recordId?: string }> {
  const { data: existing } = await supabase
    .from('webhook_events')
    .select('id, processed')
    .eq('event_id', eventId)
    .single();

  if (existing?.processed) {
    return { processed: true, recordId: existing.id };
  }

  return { processed: false, recordId: existing?.id };
}

/**
 * Record webhook event for idempotency tracking
 */
async function recordWebhookEvent(
  supabase: ReturnType<typeof createAdminClient>,
  event: Stripe.Event
): Promise<void> {
  await supabase.from('webhook_events').upsert(
    {
      event_id: event.id,
      event_type: event.type,
      payload: event as unknown as Record<string, unknown>,
      processed: false,
    },
    { onConflict: 'event_id' }
  );
}

/**
 * Mark webhook event as processed
 */
async function markEventProcessed(
  supabase: ReturnType<typeof createAdminClient>,
  eventId: string,
  error?: string
): Promise<void> {
  await supabase
    .from('webhook_events')
    .update({
      processed: !error,
      error_message: error || null,
      processed_at: new Date().toISOString(),
    })
    .eq('event_id', eventId);
}

/**
 * Handle checkout.session.completed event
 */
async function handleCheckoutCompleted(
  supabase: ReturnType<typeof createAdminClient>,
  session: Stripe.Checkout.Session
): Promise<WebhookProcessingResult> {
  const metadata = session.metadata as CheckoutMetadata | null;
  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : null;
  const orderNumber = `STRIPE-${session.id}`;

  // Validate required metadata
  if (!metadata?.book_id || !metadata?.user_id) {
    console.error('[Webhook] Missing required metadata in checkout session:', session.id);
    return {
      success: false,
      error: 'Missing required metadata (book_id or user_id)',
      event_id: session.id,
      event_type: 'checkout.session.completed',
    };
  }

  // Phoenix dual-run: Mongo orders use embedded items + PI upsert (2b.1.4).
  if (isMongoPrimary()) {
    const piKey = paymentIntentId || `session_${session.id}`;
    const totalAmount = session.amount_total ? session.amount_total / 100 : 0;
    const { inserted, orderId } = await upsertOrderByPaymentIntent({
      user_id: metadata.user_id,
      stripe_payment_intent_id: piKey,
      stripe_session_id: session.id,
      amount: totalAmount,
      currency: (session.currency || 'usd').toLowerCase(),
      order_items: [
        {
          book_id: metadata.book_id,
          title: metadata.book_slug || metadata.book_id,
          quantity: 1,
          unit_amount: totalAmount,
          currency: (session.currency || 'usd').toLowerCase(),
        },
      ],
    });

    return {
      success: true,
      event_id: session.id,
      event_type: 'checkout.session.completed',
      action_taken: inserted
        ? `Mongo order created (${orderId})`
        : `Mongo order already existed (${orderId})`,
    };
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', metadata.user_id)
    .single();

  if (profileError || !profile) {
    console.error('[Webhook] Failed to resolve purchasing profile:', profileError);
    return {
      success: false,
      error: `Failed to resolve purchasing profile: ${profileError?.message || 'Profile not found'}`,
      event_id: session.id,
      event_type: 'checkout.session.completed',
      should_retry: true,
    };
  }

  // Check for duplicate order (additional idempotency check)
  let existingOrderQuery = supabase.from('orders').select('id').limit(1);

  existingOrderQuery = paymentIntentId
    ? existingOrderQuery.eq('payment_intent_id', paymentIntentId)
    : existingOrderQuery.eq('order_number', orderNumber);

  const { data: existingOrders } = await existingOrderQuery;
  const existingOrder = existingOrders?.[0];

  if (existingOrder) {
    // Fulfillment already happened for this payment; creating order items here
    // would mint a second license for the same purchase, so skip and ack.
    console.log('[Webhook] Order already exists for session:', session.id);
    return {
      success: true,
      event_id: session.id,
      event_type: 'checkout.session.completed',
      action_taken: 'Order already exists, skipped duplicate fulfillment',
    };
  }

  // Create the order. With the partial unique index on orders(payment_intent_id)
  // (20260814090000) this insert is the atomic idempotency claim for fulfillment.
  const totalAmount = session.amount_total ? session.amount_total / 100 : 0;
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      order_number: orderNumber,
      user_id: profile.id,
      total_amount: totalAmount,
      payment_intent_id: paymentIntentId,
      status: 'completed',
    })
    .select('id')
    .single();

  // Unique violation: a concurrent delivery won the race between our SELECT
  // above and this insert (keyed on payment_intent_id, or order_number for
  // PI-less sessions). The order is fulfilled — ack instead of double-creating.
  // supabase-js upsert() can't target a partial unique index (PostgREST cannot
  // express the index predicate), so insert-then-23505 is the upsert here.
  if (orderError?.code === '23505') {
    console.log('[Webhook] Order already created by a concurrent delivery:', session.id);
    return {
      success: true,
      event_id: session.id,
      event_type: 'checkout.session.completed',
      action_taken: 'Order already exists, skipped duplicate fulfillment',
    };
  }

  if (orderError || !order) {
    console.error('[Webhook] Failed to create order:', orderError);
    return {
      success: false,
      error: `Failed to create order: ${orderError?.message || 'No order returned'}`,
      event_id: session.id,
      event_type: 'checkout.session.completed',
      should_retry: true,
    };
  }

  const { error: itemError } = await supabase.from('order_items').insert({
    order_id: order.id,
    book_id: metadata.book_id,
    unit_price: totalAmount,
    // Crypto-random: timestamp-based keys were guessable and could collide.
    license_key: `LIC-${randomUUID()}`,
  });

  if (itemError) {
    console.error('[Webhook] Failed to create order item:', itemError);
    return {
      success: false,
      error: `Failed to create order item: ${itemError.message}`,
      event_id: session.id,
      event_type: 'checkout.session.completed',
      should_retry: true,
    };
  }

  // Track analytics event
  await supabase.from('analytics_events').insert({
    book_id: metadata.book_id,
    user_id: metadata.user_id,
    event_type: 'purchase',
    session_id: session.id,
    event_data: {
      amount: totalAmount,
      currency: session.currency?.toUpperCase() || 'USD',
    },
  });

  console.log('[Webhook] Order created successfully:', session.id);

  return {
    success: true,
    event_id: session.id,
    event_type: 'checkout.session.completed',
    action_taken: 'Order created successfully',
  };
}

/**
 * Handle checkout.session.expired event
 */
async function handleCheckoutExpired(
  session: Stripe.Checkout.Session
): Promise<WebhookProcessingResult> {
  console.log('[Webhook] Checkout session expired:', session.id);

  // Optionally track abandoned checkout
  return {
    success: true,
    event_id: session.id,
    event_type: 'checkout.session.expired',
    action_taken: 'Logged expired session',
  };
}

/**
 * Handle charge.refunded event
 */
async function handleChargeRefunded(
  supabase: ReturnType<typeof createAdminClient>,
  charge: Stripe.Charge
): Promise<WebhookProcessingResult> {
  const paymentIntentId = charge.payment_intent as string;

  // Find the order by payment intent (orders stores it as payment_intent_id)
  const { data: order, error: findError } = await supabase
    .from('orders')
    .select('id, status')
    .eq('payment_intent_id', paymentIntentId)
    .single();

  if (findError || !order) {
    console.warn('[Webhook] Order not found for refund:', paymentIntentId);
    return {
      success: true,
      event_id: charge.id,
      event_type: 'charge.refunded',
      action_taken: 'Order not found, logged for review',
    };
  }

  // Update order status (orders has no refund_reason column; that lives on book_sales)
  const { error: updateError } = await supabase
    .from('orders')
    .update({ status: 'refunded' })
    .eq('id', order.id);

  if (updateError) {
    console.error('[Webhook] Failed to update order status:', updateError);
    return {
      success: false,
      error: `Failed to update order: ${updateError.message}`,
      event_id: charge.id,
      event_type: 'charge.refunded',
      should_retry: true,
    };
  }

  return {
    success: true,
    event_id: charge.id,
    event_type: 'charge.refunded',
    action_taken: 'Order marked as refunded',
  };
}

/**
 * Handle payment_intent.payment_failed event
 */
async function handlePaymentFailed(charge: Stripe.PaymentIntent): Promise<WebhookProcessingResult> {
  console.warn('[Webhook] Payment failed:', charge.id, charge.last_payment_error?.message);

  // Could trigger email notification here

  return {
    success: true,
    event_id: charge.id,
    event_type: 'payment_intent.payment_failed',
    action_taken: 'Logged payment failure',
  };
}

/**
 * Main webhook handler
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const startTime = Date.now();

  // Rate limiting
  const clientId = getClientIdentifier(request);
  if (!webhookSecret) {
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 503 });
  }

  const rateLimitResult = await enforceRateLimit('webhook', clientId);
  if (!rateLimitResult.success) {
    // Fail-closed: 503 lets Stripe retry the event; 429 signals real overload.
    console.warn('[Webhook] Rate limit rejection for:', clientId, rateLimitResult.reason);
    return NextResponse.json(
      {
        error:
          rateLimitResult.reason === 'unavailable'
            ? 'Rate limiter unavailable'
            : 'Rate limit exceeded',
      },
      {
        status: rateLimitResult.reason === 'unavailable' ? 503 : 429,
        headers: rateLimitResult.headers,
      }
    );
  }

  // Get raw body for signature verification
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    console.error('[Webhook] Missing stripe-signature header');
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  // Verify signature
  const verification = verifySignature(body, signature);
  if (!verification.valid || !verification.event) {
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${verification.error}` },
      { status: 400 }
    );
  }

  const event = verification.event;
  console.log(`[Webhook] Received event: ${event.type} (${event.id})`);

  // Initialize Supabase client
  const supabase = createAdminClient();

  // Check idempotency
  // Phoenix dual-run (F6.2): the event-log ledger has a Mongo leg, separate
  // from order-level idempotency (upsertOrderByPaymentIntent) above.
  const idempotencyCheck = isMongoPrimary()
    ? await checkWebhookEventProcessed(event.id)
    : await checkIdempotency(supabase, event.id);
  if (idempotencyCheck.processed) {
    console.log(`[Webhook] Event already processed: ${event.id}`);
    return NextResponse.json({
      received: true,
      message: 'Event already processed',
    });
  }

  // Record the event
  if (isMongoPrimary()) {
    await recordWebhookEventMongo(event);
  } else {
    await recordWebhookEvent(supabase, event);
  }

  // Process the event
  let result: WebhookProcessingResult;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        result = await handleCheckoutCompleted(supabase, session);
        // Purchase receipt (feat/topdog-comms): best-effort — never block or
        // retry fulfillment because of email. The trigger also never throws.
        if (result.success) {
          try {
            await sendPurchaseReceiptForCheckoutSession(session);
          } catch (receiptError) {
            console.error('[Webhook] Receipt email failed (ignored):', receiptError);
          }
        }
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        result = await handleCheckoutExpired(session);
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        result = await handleChargeRefunded(supabase, charge);
        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        result = await handlePaymentFailed(paymentIntent);
        break;
      }

      default: {
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
        result = {
          success: true,
          event_id: event.id,
          event_type: event.type,
          action_taken: 'Event type not handled',
        };
      }
    }

    // Mark as processed
    if (isMongoPrimary()) {
      await markWebhookEventProcessedMongo(event.id, result.success ? undefined : result.error);
    } else {
      await markEventProcessed(supabase, event.id, result.success ? undefined : result.error);
    }

    const duration = Date.now() - startTime;
    console.log(`[Webhook] Processed ${event.type} in ${duration}ms:`, result);

    if (!result.success && result.should_retry) {
      // Return 500 to trigger Stripe retry
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      received: true,
      result,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Webhook] Error processing ${event.type}:`, error);

    // Mark as failed
    if (isMongoPrimary()) {
      await markWebhookEventProcessedMongo(event.id, errorMessage);
    } else {
      await markEventProcessed(supabase, event.id, errorMessage);
    }

    // Return 500 to trigger retry for unexpected errors
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Reject non-POST requests
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
