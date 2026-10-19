import type { Scenario } from '../types.js';

/**
 * Adobe careers (Phenom ATS) multi-step application.
 *
 * Phenom hides `applicantSource` and several tracking fields as `display: none`
 * or `aria-hidden="true"` — these aren't in the accessibility tree but ARE in
 * the DOM. Filling them requires direct DOM mutation via execute.eval.
 * The form is split across 4-5 steps with a "Continue" button that only
 * enables after async validation finishes.
 */
export const adobePhenom: Scenario = {
  id: 'adobe-phenom',
  description: 'Apply to an Adobe job through the Phenom ATS multi-step flow',
  url: 'https://careers.adobe.com/us/en/job/{job-id}/apply',
  preconditions: [
    'Resume PDF available at candidate/current/Tushar Agarwal Resume.pdf',
    'No existing Phenom session (cleared cookies for adobe.com)',
    'Network: external — page loads ~3MB of JS',
  ],
  steps: [
    { action: 'navigate', target: '{job-url}' },
    { action: 'click', target: { text: 'Apply Now', role: 'button' } },
    { action: 'wait', target: 'step-1-loaded' },
    {
      action: 'fill_form',
      fields: {
        firstName: 'Tushar',
        lastName: 'Agarwal',
        email: 't.ushara0901@gmail.com',
        phone: '+918670263451',
        country: 'India',
      },
    },
    {
      action: 'eval',
      target: { selector: 'input[name="applicantSource"]' },
      criteria: 'Set hidden applicantSource field to "LinkedIn"',
    },
    { action: 'click', target: { text: 'Upload resume', role: 'button' } },
    { action: 'click', target: { text: 'Continue', role: 'button' } },
    { action: 'wait', target: 'step-2-loaded' },
    {
      action: 'fill_form',
      fields: {
        workAuthorization: 'I am authorized to work in this country',
        relocation: 'Yes',
        noticePeriod: '30 days',
      },
    },
    { action: 'click', target: { text: 'Submit Application', role: 'button' } },
    { action: 'verify', criteria: 'Thank you page or confirmation email reference visible' },
  ],
  knownFailures: [
    'applicantSource and other hidden tracking fields not in a11y tree — must use execute.eval to set value + dispatch input event',
    'Continue button is disabled until async validation resolves; need wait_for state change, not fixed sleep',
    'File upload uses a custom dropzone — `<input type="file">` is `display: none`, must reveal via JS before upload',
    'Page navigation between steps clears stale element refs — must re-snapshot after each Continue',
  ],
  successCriteria: 'Confirmation page reached OR application ID returned by Phenom API call',
};
