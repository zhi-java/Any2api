export const CHART_THEME = {
  colors: {
    primary: '#4f46e5',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#6366f1',
    cyan: '#06b6d4',
    grid: 'rgba(148, 163, 184, 0.25)',
    text: '#64748b',
  },
  font: {
    family: "Inter, 'Segoe UI', system-ui, sans-serif",
    size: 12,
    weight: 400,
  },
};

export function initChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.font.family = CHART_THEME.font.family;
  Chart.defaults.color = CHART_THEME.colors.text;
  Chart.defaults.borderColor = CHART_THEME.colors.grid;
}

export function lineOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 120 },
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: {
        labels: {
          color: CHART_THEME.colors.text,
          boxWidth: 10,
          usePointStyle: true,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(255,255,255,.96)',
        borderColor: 'rgba(83, 97, 115, .18)',
        borderWidth: 1,
        titleColor: '#152033',
        bodyColor: '#536173',
        displayColors: true,
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: CHART_THEME.colors.text, maxTicksLimit: 6 } },
      y: { beginAtZero: true, grid: { color: CHART_THEME.colors.grid }, ticks: { color: CHART_THEME.colors.text } },
    },
  };
}

export function createLineChartConfig(labels, datasets) {
  return {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map(dataset => ({
        ...dataset,
        borderColor: dataset.borderColor || CHART_THEME.colors.primary,
        backgroundColor: dataset.backgroundColor || 'rgba(79, 70, 229, 0.10)',
        tension: dataset.tension ?? 0.25,
        fill: dataset.fill ?? true,
        pointRadius: dataset.pointRadius ?? 0,
      })),
    },
    options: lineOptions(),
  };
}

window.ZhiCharts = { initChartDefaults, lineOptions, createLineChartConfig, CHART_THEME };
