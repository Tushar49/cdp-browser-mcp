/**
 * Device presets (5.1.0 A4) — Chromium-family subset of responsive-testing
 * descriptors. Shape mirrors Playwright's deviceDescriptorsSource.json
 * (Apache-2.0; values simplified to stable viewport/UA baselines).
 *
 * Applied via Emulation.setDeviceMetricsOverride + setTouchEmulationEnabled
 * + setUserAgentOverride — no new dependencies, no domain-enable requirements.
 */

export interface DeviceDescriptor {
  /** CSS viewport width in px (portrait). */
  width: number;
  /** CSS viewport height in px (portrait). */
  height: number;
  /** Device pixel ratio. */
  deviceScaleFactor: number;
  /** Mobile browsing context (affects media queries, layout viewport). */
  mobile: boolean;
  /** Touch events enabled. */
  hasTouch: boolean;
  /** Full user-agent string. */
  userAgent: string;
}

const CHROME_MOBILE_UA = (model: string, android: string): string =>
  `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36`;

const IOS_UA = (device: string, os: string): string =>
  `Mozilla/5.0 (${device}; CPU ${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1`;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const DEVICE_PRESETS: Record<string, DeviceDescriptor> = {
  'Pixel 7': {
    width: 412, height: 915, deviceScaleFactor: 2.625,
    mobile: true, hasTouch: true,
    userAgent: CHROME_MOBILE_UA('Pixel 7', '14'),
  },
  'Pixel 5': {
    width: 393, height: 851, deviceScaleFactor: 2.75,
    mobile: true, hasTouch: true,
    userAgent: CHROME_MOBILE_UA('Pixel 5', '14'),
  },
  'Galaxy S20': {
    width: 360, height: 800, deviceScaleFactor: 3.5,
    mobile: true, hasTouch: true,
    userAgent: CHROME_MOBILE_UA('SM-G981B', '13'),
  },
  'iPhone 15': {
    width: 393, height: 659, deviceScaleFactor: 3,
    mobile: true, hasTouch: true,
    userAgent: IOS_UA('iPhone', 'OS 17_5'),
  },
  'iPhone 12': {
    width: 390, height: 664, deviceScaleFactor: 3,
    mobile: true, hasTouch: true,
    userAgent: IOS_UA('iPhone', 'OS 16_6'),
  },
  'iPhone SE': {
    width: 375, height: 667, deviceScaleFactor: 2,
    mobile: true, hasTouch: true,
    userAgent: IOS_UA('iPhone', 'OS 16_6'),
  },
  'iPad Pro 11': {
    width: 834, height: 1194, deviceScaleFactor: 2,
    mobile: true, hasTouch: true,
    userAgent: IOS_UA('iPad', 'OS 17_5'),
  },
  'Desktop 1920x1080': {
    width: 1920, height: 1080, deviceScaleFactor: 1,
    mobile: false, hasTouch: false,
    userAgent: DESKTOP_UA,
  },
  'Desktop 1366x768': {
    width: 1366, height: 768, deviceScaleFactor: 1,
    mobile: false, hasTouch: false,
    userAgent: DESKTOP_UA,
  },
};

export function listDeviceNames(): string[] {
  return Object.keys(DEVICE_PRESETS);
}
