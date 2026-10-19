export { runScenario, compareScenario } from './runner.js';
export type { Scenario, ScenarioStep, RunResult } from './types.js';
export type { RunOptions, CompareResult } from './runner.js';

import { linkedinEasyApply } from './scenarios/linkedin-easy-apply.js';
import { adobePhenom } from './scenarios/adobe-phenom.js';
import { hiristOverlay } from './scenarios/hirist-403-overlay.js';
import { greenhouseRecaptcha } from './scenarios/greenhouse-recaptcha.js';
import { workdayIframes } from './scenarios/workday-iframes.js';
import { googleFormsPhone } from './scenarios/google-forms-phone.js';

export const allScenarios = [
  linkedinEasyApply,
  adobePhenom,
  hiristOverlay,
  greenhouseRecaptcha,
  workdayIframes,
  googleFormsPhone,
];
