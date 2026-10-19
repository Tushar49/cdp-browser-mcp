import type { Scenario } from '../types.js';

/**
 * Generic Greenhouse-hosted careers form with reCAPTCHA on submit.
 *
 * Greenhouse comboboxes (degree, discipline, school) are React-controlled and
 * don't accept value via raw `fill()`. They need: type text -> wait for the
 * filtered listbox -> click the option. reCAPTCHA v2 requires a real human
 * token (use 2captcha in CI) or an enterprise bypass key.
 */
export const greenhouseRecaptcha: Scenario = {
  id: 'greenhouse-recaptcha',
  description: 'Submit a Greenhouse application form with React comboboxes and a reCAPTCHA challenge',
  url: 'https://boards.greenhouse.io/{org}/jobs/{job-id}',
  preconditions: [
    'CAPTCHA_TOKEN env var set (2captcha solver) OR enterprise bypass key configured',
    'Resume PDF + cover letter TXT available',
    'No active Greenhouse session that pre-fills fields',
  ],
  steps: [
    { action: 'navigate', target: '{job-url}' },
    {
      action: 'fill_form',
      fields: {
        first_name: 'Tushar',
        last_name: 'Agarwal',
        email: 't.ushara0901@gmail.com',
        phone: '+918670263451',
        'job_application[answers_attributes][0][text_value]': '6 months',
      },
    },
    { action: 'click', target: { selector: 'input[type="file"][name*="resume"]' } },
    {
      action: 'fill_form',
      fields: {
        degree: "Bachelor's Degree",
        discipline: 'Computer Science',
        school: 'Galgotias University',
      },
    },
    {
      action: 'eval',
      criteria: 'Inject reCAPTCHA token into g-recaptcha-response textarea from CAPTCHA_TOKEN env',
    },
    { action: 'click', target: { text: 'Submit Application', role: 'button' } },
    { action: 'verify', criteria: 'Redirect to /confirmation OR "Thanks for applying" banner' },
  ],
  knownFailures: [
    'React combobox: typing the text does not select it — must type, wait for filtered listbox, then click the option by visible text',
    'reCAPTCHA v2 cannot be solved by CDP — must inject `g-recaptcha-response` token from a solver service OR run headed with manual intervention',
    'Greenhouse rejects submissions when the User-Agent suggests automation — keep a real Chrome UA',
    'Some boards use a custom `<select>` polyfill that intercepts `change` events — set value AND dispatch React-synthetic change',
  ],
  successCriteria: 'POST /api/v1/job_applications returns 200 AND confirmation page loads',
};
