export function runMetricMaintenance(store, { now = new Date(), lastVacuumDate = null, vacuumMaxBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  const anchor = now.toISOString();
  store.deleteMetricsByNameAndSource('usage_event', '%', 90, anchor);
  store.deleteMetricsByNameAndSource('ttft%', '%', 90, anchor);
  store.deleteMetricsByNameAndSource('turn_duration%', '%', 90, anchor);
  store.deleteMetricsByNameAndSource('statusline_summary', '%', 30, anchor);
  store.deleteMetricsByNameAndSource('system_summary', '%', 14, anchor);
  store.deleteMetricsByNameAndSource('pm2_summary', '%', 7, anchor);
  store.deleteMetricsByNameAndSource('pm2_cpu', '%', 0, anchor);
  store.deleteMetricsByNameAndSource('pm2_memory', '%', 0, anchor);
  store.deleteMetricsByNameAndSource('pm2_restarts', '%', 0, anchor);
  store.deleteMetricsByNameAndSource('pm2_status', '%', 0, anchor);
  store.deleteMetricsByNameAndSource('pm2_uptime', '%', 0, anchor);
  store.deleteOtherLegacyMetricsOlderThan(90, anchor);
  store.deleteEventsOlderThan(30, anchor);
  store.deleteSnapshotsOlderThan(7, anchor);
  store.deleteFactsOlderThan(365, anchor);
  store.walCheckpoint();

  const dateKey = anchor.slice(0, 10);
  const shouldVacuum = now.getUTCDay() === 0 && lastVacuumDate !== dateKey;
  if (!shouldVacuum) return { vacuum: null, lastVacuumDate };
  const vacuum = store.vacuumIfSmall(vacuumMaxBytes);
  return { vacuum, lastVacuumDate: dateKey };
}
