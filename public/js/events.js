export function connectEvents(onSummary, fallbackRefresh) {
  if (!window.EventSource) {
    setInterval(fallbackRefresh, 5000);
    return;
  }

  const basePath = document.documentElement.dataset.basePath || '';
  const source = new EventSource(`${basePath}/api/events`);
  let fallbackTimer = null;

  source.addEventListener('metrics', (event) => {
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    try {
      onSummary(JSON.parse(event.data));
    } catch {
      fallbackRefresh();
    }
  });

  source.addEventListener('error', () => {
    if (!fallbackTimer) {
      fallbackTimer = setInterval(fallbackRefresh, 5000);
    }
  });
}
