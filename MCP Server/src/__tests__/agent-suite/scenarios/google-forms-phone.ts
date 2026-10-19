import type { Scenario } from '../types.js';

/**
 * Google Forms with a phone-number question that has a country-code combobox.
 *
 * The country selector is a custom Google combobox (`role="combobox"` with a
 * popup `role="listbox"`). Typing "+91" does NOT match; you must type "India"
 * or click the country flag and pick from the dropdown. Once selected, the
 * dialing prefix is rendered as static text, NOT as an editable input — so
 * the phone field receives only the local number.
 */
export const googleFormsPhone: Scenario = {
  id: 'google-forms-phone',
  description: 'Submit a Google Form whose phone question requires picking India (+91) from a combobox',
  url: 'https://docs.google.com/forms/d/e/{form-id}/viewform',
  preconditions: [
    'Logged in to Google as t.ushara0901@gmail.com (URL must contain /u/1/)',
    'Form is publicly accessible OR shared with this account',
  ],
  steps: [
    { action: 'navigate', target: '{form-url}' },
    { action: 'verify', criteria: 'URL contains /u/1/ — confirms job-account session, not personal /u/0/' },
    {
      action: 'fill_form',
      fields: {
        'Full name': 'Tushar Agarwal',
        Email: 't.ushara0901@gmail.com',
      },
    },
    { action: 'click', target: { role: 'combobox', text: 'Country code' } },
    { action: 'wait_modal', target: 'country-listbox' },
    {
      action: 'fill_form',
      fields: { 'country search': 'India' },
    },
    { action: 'click', target: { role: 'option', text: 'India (+91)' } },
    {
      action: 'fill_form',
      fields: { 'Phone number': '8670263451' },
    },
    { action: 'click', target: { text: 'Submit', role: 'button' } },
    { action: 'verify', criteria: 'Page navigates to /formResponse with "Your response has been recorded"' },
  ],
  knownFailures: [
    'Typing "+91" into the country combobox matches nothing — must type "India" (or other country name) to filter the listbox',
    'Country combobox is `role="combobox"` not `<select>` — fill() on a select element does not work; need explicit click + type + click option flow',
    'The chosen prefix renders as static text inside the input wrapper; do NOT include "+91" in the phone field value',
    'Google Forms POST submit redirects to /formResponse — the original tab target may be invalidated; expect "No target with given id" if you keep using the old tabId',
    'If logged into /u/0/ (personal) instead of /u/1/, the form may pre-fill the wrong email and silently submit from the wrong account',
  ],
  successCriteria: 'Redirect to /formResponse confirmation page reached within 10s of clicking Submit',
};
