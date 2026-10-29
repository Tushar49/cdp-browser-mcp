/**
 * Emulate tool — device and network condition emulation.
 *
 * Single handler (not action-based). Any combination of emulation
 * properties can be set in one call. Pass `reset: true` to clear all.
 */

import type { ToolRegistry } from './registry.js';
import type { ServerContext, ToolResult } from '../types.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';
import { DEVICE_PRESETS, listDeviceNames } from './device-presets.js';
import { isMethodMissingError } from '../connection/capabilities.js';
const NL2 = String.fromCharCode(10);

// ─── Network throttling presets (mirrors server.js) ─────────────────

const NETWORK_PRESETS: Record<string, Record<string, unknown>> = {
  offline:  { offline: true,  latency: 0,      downloadThroughput: 0,       uploadThroughput: 0 },
  slow3g:   { offline: false, latency: 2000,   downloadThroughput: 50000,   uploadThroughput: 50000 },
  fast3g:   { offline: false, latency: 562.5,  downloadThroughput: 180000,  uploadThroughput: 84375 },
  slow4g:   { offline: false, latency: 150,    downloadThroughput: 400000,  uploadThroughput: 150000 },
  fast4g:   { offline: false, latency: 50,     downloadThroughput: 1500000, uploadThroughput: 750000 },
  none:     { offline: false, latency: 0,      downloadThroughput: -1,      uploadThroughput: -1 },
};

// ─── Handler ────────────────────────────────────────────────────────

async function handleEmulate(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  const results: string[] = [];

  // ── Reset all overrides ──
  if (params.reset) {
    try { await ctx.sendCommand('Emulation.clearDeviceMetricsOverride', {}, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Emulation.setEmulatedMedia', { features: [] }, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Emulation.clearGeolocationOverride', {}, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Emulation.setCPUThrottlingRate', { rate: 1 }, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Emulation.setTimezoneOverride', { timezoneId: '' }, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Emulation.setLocaleOverride', { locale: '' }, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Emulation.setEmulatedVisionDeficiency', { type: 'none' }, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Emulation.clearIdleOverride', {}, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Emulation.clearDevicePostureOverride', {}, sess); } catch { /* ok */ }
    // No clear counterpart exists - 'unknown' tier restores the default
    try { await ctx.sendCommand('Emulation.setCPUPerformanceOverride', { performanceTier: 'unknown' }, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Emulation.setUserAgentOverride', { userAgent: '' }, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Emulation.setAutoDarkModeOverride', {}, sess); } catch { /* ok */ }
    try { await ctx.sendCommand('Page.setInputVisualization', { clicks: false }, sess); } catch { /* ok */ }
    try {
      await ctx.sendCommand('Network.enable', {}, sess);
      await ctx.sendCommand('Network.emulateNetworkConditions', NETWORK_PRESETS.none, sess);
      await ctx.sendCommand('Network.setBlockedURLs', { urls: [] }, sess);
      await ctx.sendCommand('Network.setExtraHTTPHeaders', { headers: {} }, sess);
    } catch { /* ok */ }
    try {
      await ctx.sendCommand('Security.enable', {}, sess);
      await ctx.sendCommand('Security.setIgnoreCertificateErrors', { ignore: false }, sess);
    } catch { /* ok */ }
    return ok('All emulation overrides reset.');
  }

  // ── Device preset (5.1.0 A4) ──
  if (params.device === 'list') {
    return ok('Available device presets:' + NL2 + listDeviceNames().map(function (d) { return '  ' + d; }).join(NL2));
  }
  if (params.device) {
    const descriptor = DEVICE_PRESETS[params.device as string];
    if (!descriptor) {
      return fail('Unknown device preset: ' + (params.device as string) + '. Use device: list to see names.');
    }
    const explicitUA = !!params.userAgent;
    const vp = params.viewport as Record<string, unknown> | undefined;
    const width = (vp ? (vp.width as number) : descriptor.width) ?? descriptor.width;
    const height = (vp ? (vp.height as number) : descriptor.height) ?? descriptor.height;
    await ctx.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: descriptor.deviceScaleFactor,
      mobile: descriptor.mobile,
    }, sess);
    if (descriptor.hasTouch) {
      await ctx.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sess);
    }
    if (!explicitUA) {
      await ctx.sendCommand('Emulation.setUserAgentOverride', { userAgent: descriptor.userAgent }, sess);
    }
    results.push(`Device: ${params.device} - ${width}x${height} @${descriptor.deviceScaleFactor}x`);
  }

  // ── Viewport ──
  if (params.viewport) {
    const v = params.viewport as Record<string, unknown>;
    const width = v.landscape ? ((v.height as number) || 720) : ((v.width as number) || 1280);
    const height = v.landscape ? ((v.width as number) || 1280) : ((v.height as number) || 720);
    await ctx.sendCommand('Emulation.setDeviceMetricsOverride', {
      width, height,
      deviceScaleFactor: (v.deviceScaleFactor as number) || 1,
      mobile: (v.mobile as boolean) || false,
    }, sess);
    if (v.touch) {
      await ctx.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true }, sess);
    }
    results.push(`Viewport: ${width}x${height}${v.mobile ? ' (mobile)' : ''}${v.touch ? ' (touch)' : ''}`);
  }

  // ── Color scheme ──
  if (params.colorScheme) {
    if (params.colorScheme === 'auto') {
      await ctx.sendCommand('Emulation.setEmulatedMedia', { features: [] }, sess);
    } else {
      await ctx.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: params.colorScheme as string }],
      }, sess);
    }
    results.push(`Color scheme: ${params.colorScheme}`);
  }

  // ── User agent ──
  if (params.userAgent) {
    await ctx.sendCommand('Emulation.setUserAgentOverride', { userAgent: params.userAgent as string }, sess);
    results.push(`User agent: ${(params.userAgent as string).substring(0, 60)}`);
  }

  // ── Geolocation ──
  if (params.geolocation) {
    const geo = params.geolocation as Record<string, unknown>;
    const geoParams: Record<string, unknown> = {
      latitude: geo.latitude,
      longitude: geo.longitude,
      accuracy: (geo.accuracy as number) ?? 100,
    };
    if (geo.altitude !== undefined) geoParams.altitude = geo.altitude;
    await ctx.sendCommand('Emulation.setGeolocationOverride', geoParams, sess);

    // Auto-grant geolocation permission
    try {
      const originResult = (await ctx.sendCommand('Runtime.evaluate', {
        expression: 'location.origin', returnByValue: true,
      }, sess)) as Record<string, unknown>;
      const origin = ((originResult.result as Record<string, unknown>)?.value as string) || '';
      const grantParams: Record<string, unknown> = { permissions: ['geolocation'] };
      if (origin && origin !== 'null') grantParams.origin = origin;
      await ctx.sendCommand('Browser.grantPermissions', grantParams);
    } catch { /* ok — permission grant is best-effort */ }

    let geoMsg = `Geolocation: ${geo.latitude}, ${geo.longitude} (accuracy: ${geoParams.accuracy}m`;
    if (geoParams.altitude !== undefined) geoMsg += `, altitude: ${geoParams.altitude}m`;
    geoMsg += ')';
    results.push(geoMsg);
  }

  // ── CPU throttle ──
  if (params.cpuThrottle) {
    await ctx.sendCommand('Emulation.setCPUThrottlingRate', { rate: params.cpuThrottle as number }, sess);
    results.push(`CPU throttle: ${params.cpuThrottle}x`);
  }

  // ── Device posture (5.1.0 B3, Chrome 153+) ──
  if (params.devicePosture) {
    const posture = params.devicePosture as string;
    if (posture !== 'continuous' && posture !== 'folded') {
      return fail(`Invalid devicePosture: "${posture}". Use: continuous, folded`);
    }
    try {
      await ctx.sendCommand('Emulation.setDevicePostureOverride', { posture: { type: posture } }, sess);
      results.push(`Device posture: ${posture}`);
    } catch (err) {
      if (isMethodMissingError(err)) {
        return fail('Emulation.setDevicePostureOverride is not supported on this browser (requires Chrome 153+). Update Chrome/Brave to use device posture emulation.');
      }
      throw err;
    }
  }

  // ── CPU performance tier (5.1.0 B3, Chrome 153/154+) ──
  if (params.cpuPerformance) {
    const tier = params.cpuPerformance as string;
    if (tier !== 'low' && tier !== 'mid' && tier !== 'high' && tier !== 'ultra') {
      return fail(`Invalid cpuPerformance: "${tier}". Use: low, mid, high, ultra`);
    }
    try {
      await ctx.sendCommand('Emulation.setCPUPerformanceOverride', { performanceTier: tier }, sess);
      results.push(`CPU performance: ${tier} tier`);
    } catch (err) {
      if (isMethodMissingError(err)) {
        return fail('Emulation.setCPUPerformanceOverride is not supported on this browser (requires Chrome 153/154+). Update Chrome/Brave to use CPU performance emulation.');
      }
      throw err;
    }
  }

  // ── Timezone ──
  if (params.timezone) {
    await ctx.sendCommand('Emulation.setTimezoneOverride', { timezoneId: params.timezone as string }, sess);
    results.push(`Timezone: ${params.timezone}`);
  }

  // ── Locale ──
  if (params.locale) {
    await ctx.sendCommand('Emulation.setLocaleOverride', { locale: params.locale as string }, sess);
    results.push(`Locale: ${params.locale}`);
  }

  // ── Vision deficiency ──
  if (params.visionDeficiency) {
    await ctx.sendCommand('Emulation.setEmulatedVisionDeficiency', { type: params.visionDeficiency as string }, sess);
    results.push(`Vision deficiency: ${params.visionDeficiency}`);
  }

  // ── Auto dark mode ──
  if (params.autoDarkMode !== undefined) {
    await ctx.sendCommand('Emulation.setAutoDarkModeOverride', { enabled: params.autoDarkMode as boolean }, sess);
    results.push(`Auto dark mode: ${params.autoDarkMode}`);
  }

  // ── Idle state ──
  if (params.idle) {
    if (params.idle === 'active') {
      await ctx.sendCommand('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true }, sess);
    } else {
      await ctx.sendCommand('Emulation.setIdleOverride', { isUserActive: false, isScreenUnlocked: false }, sess);
    }
    results.push(`Idle state: ${params.idle}`);
  }

  // ── Network condition ──
  if (params.networkCondition) {
    const preset = NETWORK_PRESETS[params.networkCondition as string];
    if (!preset) {
      return fail(`Unknown network condition: ${params.networkCondition}. Use: ${Object.keys(NETWORK_PRESETS).join(', ')}`);
    }
    await ctx.sendCommand('Network.enable', {}, sess);
    await ctx.sendCommand('Network.emulateNetworkConditions', preset, sess);
    results.push(`Network: ${params.networkCondition}`);
  }

  // ── Input visualization (5.3 WS4 — Page.setInputVisualization) ──
  if (params.inputVisualization !== undefined) {
    try { await ctx.sendCommand('Page.enable', {}, sess); } catch { /* ok */ }
    try {
      await ctx.sendCommand('Page.setInputVisualization', { clicks: Boolean(params.inputVisualization) }, sess);
      results.push(`Input visualization: ${params.inputVisualization ? 'on (click markers)' : 'off'}`);
    } catch (e) {
      if (isMethodMissingError(e)) {
        return fail('Page.setInputVisualization is unsupported on this browser (needs Chrome 153+; Brave: chrome://flags #devtools-webmcp-support).');
      }
      throw e;
    }
  }

  // ── Ignore SSL ──
  if (params.ignoreSSL !== undefined) {
    await ctx.sendCommand('Security.enable', {}, sess);
    await ctx.sendCommand('Security.setIgnoreCertificateErrors', { ignore: params.ignoreSSL as boolean }, sess);
    results.push(`Ignore SSL: ${params.ignoreSSL}`);
  }

  // ── Block URLs ──
  if (params.blockUrls) {
    await ctx.sendCommand('Network.enable', {}, sess);
    await ctx.sendCommand('Network.setBlockedURLs', { urls: params.blockUrls as string[] }, sess);
    results.push(`Blocked URLs: ${(params.blockUrls as string[]).length} pattern(s)`);
  }

  // ── Extra headers ──
  if (params.extraHeaders) {
    await ctx.sendCommand('Network.enable', {}, sess);
    await ctx.sendCommand('Network.setExtraHTTPHeaders', { headers: params.extraHeaders as Record<string, string> }, sess);
    results.push(`Extra headers: ${Object.keys(params.extraHeaders as Record<string, string>).join(', ')}`);
  }

  return ok(results.length ? results.join('\n') : 'No emulation changes applied.');
}

// ─── Registration ───────────────────────────────────────────────────

export function registerEmulateTools(
  registry: ToolRegistry,
  _ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'emulate',
      description: [
        "Use this to test responsive design, mobile views, or simulate slow networks. Set any combination of properties in one call. Pass 'reset: true' to clear all overrides.",
        '',
        'Operations (set any combination in a single call):',
        '- device: Apply a device preset (optional: device name or list; overrides viewport+UA unless explicitly given)',
        '- viewport: Set viewport dimensions (optional: {width, height, deviceScaleFactor, mobile, touch, landscape})',
        '- colorScheme: Emulate preferred color scheme (optional: dark|light|auto)',
        '- userAgent: Override the browser user agent string (optional: string)',
        '- geolocation: Spoof geolocation (optional: {latitude, longitude, accuracy, altitude})',
        '- cpuThrottle: Throttle CPU speed — 1 = normal, 4 = 4x slower (optional: number)',
        "- timezone: Override timezone (optional: string, e.g. 'America/New_York')",
        "- locale: Override locale (optional: string, e.g. 'fr-FR')",
        '- visionDeficiency: Simulate vision impairment (optional: none|protanopia|deuteranopia|tritanopia|achromatopsia|blurredVision)',
        '- autoDarkMode: Force automatic dark mode (optional: boolean)',
        '- idle: Emulate idle/locked screen state (optional: active|locked)',
        '- devicePosture: Foldable device posture override (optional: continuous|folded; Chrome 153+)',
        '- cpuPerformance: CPU performance tier override (optional: low|mid|high|ultra; Chrome 153/154+)',
        '- networkCondition: Throttle network speed (optional: offline|slow3g|fast3g|slow4g|fast4g|none)',
        '- inputVisualization: Show click markers on the page (optional: boolean; Page.setInputVisualization, Chrome 153+; cleared by reset)',
        '- ignoreSSL: Bypass SSL certificate errors (optional: boolean)',
        '- blockUrls: Block requests matching URL patterns (optional: string array)',
        '- extraHeaders: Set extra HTTP headers on all requests (optional: object)',
        '- reset: Clear ALL emulation overrides (optional: true)',
        '',
        'Network Presets: offline (no connection), slow3g (2s latency, 50KB/s), fast3g (562ms, 180KB/s), slow4g (150ms, 400KB/s), fast4g (50ms, 1.5MB/s), none (remove throttling)',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab ID.' },
          viewport: {
            type: 'object', description: 'Viewport {width, height, deviceScaleFactor, mobile, touch, landscape}.',
            properties: {
              width: { type: 'number' }, height: { type: 'number' },
              deviceScaleFactor: { type: 'number' }, mobile: { type: 'boolean' },
              touch: { type: 'boolean' }, landscape: { type: 'boolean' },
            },
          },
          device: { type: 'string', description: 'Device preset name (device: list to enumerate). Applied viewport + DSF + mobile + touch + UA. Explicit viewport/userAgent params override the preset.' },
          colorScheme: { type: 'string', enum: ['dark', 'light', 'auto'], description: 'Color scheme.' },
          userAgent: { type: 'string', description: 'User agent string.' },
          geolocation: {
            type: 'object',
            properties: {
              latitude: { type: 'number' }, longitude: { type: 'number' },
              accuracy: { type: 'number', description: 'GPS accuracy in meters (default: 100).' },
              altitude: { type: 'number', description: 'Altitude in meters (optional).' },
            },
            description: 'Spoof geolocation: {latitude, longitude, accuracy?, altitude?}.',
          },
          cpuThrottle: { type: 'number', description: 'CPU throttle rate (1 = normal).' },
          timezone: { type: 'string', description: "Timezone, e.g. 'America/New_York'." },
          locale: { type: 'string', description: "Locale, e.g. 'fr-FR'." },
          visionDeficiency: { type: 'string', enum: ['none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurredVision'], description: 'Vision deficiency simulation.' },
          autoDarkMode: { type: 'boolean', description: 'Auto dark mode.' },
          idle: { type: 'string', enum: ['active', 'locked'], description: 'Idle state.' },
          devicePosture: { type: 'string', enum: ['continuous', 'folded'], description: 'Device posture override (Chrome 153+).' },
          cpuPerformance: { type: 'string', enum: ['low', 'mid', 'high', 'ultra'], description: 'CPU performance tier override (Chrome 153/154+).' },
          networkCondition: { type: 'string', enum: ['offline', 'slow3g', 'fast3g', 'slow4g', 'fast4g', 'none'], description: 'Network throttle preset.' },
          inputVisualization: { type: 'boolean', description: 'Show click markers on the page (Page.setInputVisualization; cleared by reset).' },
          ignoreSSL: { type: 'boolean', description: 'Ignore SSL certificate errors.' },
          blockUrls: { type: 'array', items: { type: 'string' }, description: 'URLs to block.' },
          extraHeaders: { type: 'object', description: 'Extra HTTP headers.' },
          reset: { type: 'boolean', description: 'Reset all emulation overrides.' },
          sessionId: { type: 'string', description: 'Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID.' },
          cleanupStrategy: { type: 'string', enum: ['close', 'detach', 'none'], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
          exclusive: { type: 'boolean', description: 'Lock tab to this session (default: true). Set false to allow shared access.' },
        },
        required: [],
      },
      handler: handleEmulate,
    }),
  );
}
