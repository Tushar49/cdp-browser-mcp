import type { Scenario } from '../types.js';

/**
 * LinkedIn Easy Apply on a job posting.
 *
 * LinkedIn's Ember.js front-end breaks vanilla CDP click dispatch on many
 * interactive elements, and the Easy Apply modal renders inside a portal
 * (`artdeco-modal`) — NOT a standard `role="dialog"`. After ~10-15 successful
 * applies, the modal stops rendering its form (session-level rate limit).
 * The "Follow company" checkbox has `opacity: 0` so the input is unclickable;
 * clicking its label works.
 */
export const linkedinEasyApply: Scenario = {
  id: 'linkedin-easy-apply',
  description: 'Apply to a LinkedIn job via the Easy Apply modal',
  url: 'https://www.linkedin.com/jobs/view/{job-id}',
  preconditions: [
    'Logged in to LinkedIn',
    'Job is Easy-Apply eligible',
    'Job-account Gmail u/1 active in Chrome',
    'Viewport set to 1920x1080 on the active tab',
  ],
  steps: [
    { action: 'navigate', target: '{job-url}' },
    { action: 'snapshot', target: 'job-detail' },
    { action: 'click', target: { text: 'Easy Apply', role: 'button' } },
    { action: 'wait_modal', target: 'artdeco-modal' },
    {
      action: 'fill_form',
      fields: {
        phoneCountryCode: 'India (+91)',
        phone: '8670263451',
        email: 't.ushara0901@gmail.com',
      },
    },
    { action: 'click', target: { text: 'Next', role: 'button' } },
    { action: 'click', target: { text: 'Review', role: 'button' } },
    { action: 'click', target: { selector: 'label[for="follow-company-checkbox"]' } },
    { action: 'click', target: { text: 'Submit application', role: 'button' } },
    { action: 'verify', criteria: 'Application sent confirmation visible' },
  ],
  knownFailures: [
    'Ember.js: CDP click does not fire — use JS-click fallback (`el.click()` via execute.eval)',
    'After 10-15 apps, modal stops rendering form (session-level block)',
    '"Follow company" checkbox has opacity:0 — click label not input',
    'Easy Apply modal uses `.artdeco-modal`, not `role="dialog"` — `querySelector(\'[role=dialog]\')` returns null',
    'Phone country code is a typeahead combobox: must type "India" then click "India (+91)" option, not raw +91',
  ],
  successCriteria: 'Confirmation banner "Your application was sent to {Company}" OR tracker entry updated to applied',
};
