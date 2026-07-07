export const CHART_THEME = {
  colors: {
    primary: '#007aff',
    success: '#0a8f5a',
    warning: '#b87500',
    error: '#d92d20',
    info: '#5e5ce6',
    cyan: '#32ade6',
    grid: 'rgba(83, 97, 115, 0.14)',
    text: '#536173',
  },
  font: {
    family: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Inter, sans-serif",
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
        backgroundColor: dataset.backgroundColor || 'rgba(0, 122, 255, 0.10)',
        tension: dataset.tension ?? 0.25,
        fill: dataset.fill ?? true,
        pointRadius: dataset.pointRadius ?? 0,
      })),
    },
    options: lineOptions(),
  };
}

window.ZhiCharts = { initChartDefaults, lineOptions, createLineChartConfig, CHART_THEME };
