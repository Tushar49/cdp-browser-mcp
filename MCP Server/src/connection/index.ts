/**
 * Connection module — public surface.
 */

export { CDPClient } from './cdp-client.js';
export type { ConnectionState, CDPClientOptions } from './cdp-client.js';

export {
  discoverBrowserInstances,
  resolveWsUrl,
  resolveWsUrlAsync,
  findBestInstance,
  parseBrowserCommandLine,
  scanBrowserProcesses,
} from './browser-discovery.js';
export type {
  DiscoverOptions,
  WsUrlResult,
  CommandLineInfo,
  ProcessScanResult,
} from './browser-discovery.js';

export { HealthMonitor } from './health-monitor.js';
export { DomainCapabilities } from './capabilities.js';
export type {
  HealthStatus,
  HealthState,
  HealthMonitorOptions,
  ConnectionMode,
} from './health-monitor.js';

export { DomainManager } from './domain-manager.js';

export { TabSessionService } from './tab-session-service.js';
