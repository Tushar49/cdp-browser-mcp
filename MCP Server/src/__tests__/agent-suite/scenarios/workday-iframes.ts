import type { Scenario } from '../types.js';

/**
 * Workday application with cross-origin iframes.
 *
 * Workday wraps each company tenant in its own subdomain
 * (e.g. `company.wd5.myworkdayjobs.com`) and embeds upload/verification widgets
 * in cross-origin iframes. CDP must use Target.setAutoAttach to see frame
 * targets, then traverse them. The "My Information" step ALSO uses a separate
 * `wdapp-` iframe for the address autocomplete.
 */
export const workdayIframes: Scenario = {
  id: 'workday-iframes',
  description: 'Complete a Workday application that uses cross-origin iframes for upload and address autocomplete',
  url: 'https://{company}.wd5.myworkdayjobs.com/en-US/{site}/job/{job-id}/apply',
  preconditions: [
    'Workday account created for this tenant (Workday is per-company, no SSO)',
    'Resume PDF available',
    'auto-attach enabled in CDP session (`Target.setAutoAttach: { autoAttach: true, flatten: true }`)',
  ],
  steps: [
    { action: 'navigate', target: '{job-url}' },
    { action: 'click', target: { text: 'Apply', role: 'button' } },
    { action: 'click', target: { text: 'Apply Manually', role: 'button' } },
    {
      action: 'fill_form',
      fields: {
        email: 't.ushara0901@gmail.com',
        password: '{WORKDAY_PASSWORD}',
        confirmPassword: '{WORKDAY_PASSWORD}',
      },
    },
    { action: 'click', target: { text: 'Create Account', role: 'button' } },
    { action: 'wait', target: 'application-step-1' },
    { action: 'snapshot', target: 'all-frames' },
    {
      action: 'eval',
      criteria: 'Enumerate all frames via Page.frameTree; pick the one whose URL contains `/wday/cxs/`',
    },
    {
      action: 'fill_form',
      fields: {
        firstName: 'Tushar',
        lastName: 'Agarwal',
        addressLine1: 'Hyderabad',
        city: 'Hyderabad',
        country: 'India',
      },
    },
    { action: 'click', target: { text: 'Save and Continue', role: 'button' } },
    { action: 'verify', criteria: 'Reached step "My Experience" with resume parsing in progress' },
  ],
  knownFailures: [
    'Cross-origin iframes invisible without Target.setAutoAttach — pre-v4.12.0 of our MCP saw blank pages',
    'Address autocomplete lives in a SEPARATE `wdapp-*` iframe — selector lookup in the top frame returns nothing',
    'Workday "Save and Continue" sometimes hangs at 90% — must wait for `aria-busy="false"` on the form container, not just network idle',
    'Each Workday tenant is a different origin → cookies do NOT carry across; account creation is per-tenant',
    'Resume parse step may auto-fill fields AFTER our fill_form runs — must verify final values, not assume',
  ],
  successCriteria: 'Application reaches "Review" step with all required fields populated AND no validation errors visible',
};
