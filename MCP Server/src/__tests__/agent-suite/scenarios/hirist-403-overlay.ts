import type { Scenario } from '../types.js';

/**
 * Hirist.tech with the 403 overlay that blocks the accessibility tree.
 *
 * Hirist serves an interstitial overlay (Cloudflare-style "403 Access denied")
 * on top of the real page for unauthenticated/automated agents. The overlay
 * doesn't navigate away — it just covers the tree, so snapshots return only
 * the overlay nodes. JS dismissal works because the underlying app DOM is
 * already rendered behind it.
 */
export const hiristOverlay: Scenario = {
  id: 'hirist-403-overlay',
  description: 'Dismiss the Hirist 403 overlay and read the notifications inbox',
  url: 'https://www.hirist.tech/notifications',
  preconditions: [
    'Logged in to Hirist',
    'Notifications page accessible',
  ],
  steps: [
    { action: 'navigate', target: '{url}' },
    { action: 'snapshot', target: 'page-with-overlay' },
    {
      action: 'eval',
      criteria: "document.querySelector('.access-denied-overlay, [class*=\"403\"]')?.remove(); document.body.style.overflow = 'auto';",
    },
    { action: 'wait', target: 'overlay-gone' },
    { action: 'snapshot', target: 'page-without-overlay' },
    { action: 'verify', criteria: 'Notifications list visible with at least 1 item' },
  ],
  knownFailures: [
    '403 overlay covers the tree — accessibility snapshot returns "Access Denied" body even though the real app is rendered behind it',
    'Reloading does NOT clear the overlay — it re-renders on every load',
    'Overlay class name varies (`access-denied-overlay`, `cf-error-overlay`, `403-modal`) — must try multiple selectors',
    'After removing overlay, `body.style.overflow` is still `hidden` — must reset to read full page',
  ],
  successCriteria: 'Snapshot after dismissal contains notifications list elements (links with text matching application/interview keywords)',
};
