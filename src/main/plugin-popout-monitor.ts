export interface PluginPopoutMonitorHandle<T> {
  readonly owner: T;
  readonly generation: number;
  readonly timer: NodeJS.Timeout;
}

export function isCurrentPluginPopoutMonitor<T>(
  monitor: PluginPopoutMonitorHandle<T> | undefined,
  owner: T,
  generation: number,
): monitor is PluginPopoutMonitorHandle<T> {
  return monitor !== undefined && monitor.owner === owner && monitor.generation === generation;
}

export function clearPluginPopoutMonitor<T>(
  monitor: PluginPopoutMonitorHandle<T> | undefined,
  owner: T,
  generation: number,
): PluginPopoutMonitorHandle<T> | undefined {
  if (!isCurrentPluginPopoutMonitor(monitor, owner, generation)) {
    return monitor;
  }
  clearInterval(monitor.timer);
  return undefined;
}
