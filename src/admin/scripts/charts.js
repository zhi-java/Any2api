/**
 * Chart Configuration - DeepSeek 2API Admin
 *
 * Chart.js 主题配置和工具函数
 */

export const CHART_THEME = {
  colors: {
    primary: '#3C5A78',
    success: '#10B981',
    warning: '#F59E0B',
    error: '#EF4444',
    info: '#3B82F6',
    grid: '#E7E3DA',
    text: '#6B7077',
  },

  font: {
    family: "'Inter', sans-serif",
    size: 12,
    weight: 400,
  },

  defaults: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: {
          color: '#6B7077',
          font: {
            family: "'Inter', sans-serif",
            size: 12,
          },
          padding: 16,
          usePointStyle: true,
        },
      },
      tooltip: {
        backgroundColor: '#1E2227',
        titleColor: '#FFFFFF',
        bodyColor: '#FFFFFF',
        borderColor: '#E7E3DA',
        borderWidth: 1,
        padding: 12,
        boxPadding: 6,
        usePointStyle: true,
        titleFont: {
          family: "'Inter', sans-serif",
          size: 13,
          weight: 600,
        },
        bodyFont: {
          family: "'Inter', sans-serif",
          size: 12,
        },
      },
    },
    scales: {
      x: {
        grid: {
          color: '#E7E3DA',
          drawBorder: false,
        },
        ticks: {
          color: '#6B7077',
          font: {
            family: "'Inter', sans-serif",
            size: 11,
          },
        },
      },
      y: {
        grid: {
          color: '#E7E3DA',
          drawBorder: false,
        },
        ticks: {
          color: '#6B7077',
          font: {
            family: "'Inter', sans-serif",
            size: 11,
          },
        },
      },
    },
  },
};

/**
 * 初始化 Chart.js 全局配置
 */
export function initChartDefaults() {
  if (typeof Chart !== 'undefined') {
    Chart.defaults.font.family = CHART_THEME.font.family;
    Chart.defaults.color = CHART_THEME.colors.text;
  }
}

/**
 * 创建折线图配置
 */
export function createLineChartConfig(labels, datasets) {
  return {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map(ds => ({
        ...ds,
        borderColor: ds.borderColor || CHART_THEME.colors.primary,
        backgroundColor: ds.backgroundColor || 'rgba(60, 90, 120, 0.1)',
        tension: ds.tension !== undefined ? ds.tension : 0.3,
        fill: ds.fill !== undefined ? ds.fill : true,
      })),
    },
    options: CHART_THEME.defaults,
  };
}

/**
 * 创建环形图配置
 */
export function createDoughnutChartConfig(labels, data, backgroundColors) {
  return {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: backgroundColors || [
          CHART_THEME.colors.success,
          CHART_THEME.colors.primary,
          CHART_THEME.colors.error,
        ],
        borderWidth: 0,
      }],
    },
    options: {
      ...CHART_THEME.defaults,
      cutout: '60%',
    },
  };
}

/**
 * 创建柱状图配置
 */
export function createBarChartConfig(labels, datasets) {
  return {
    type: 'bar',
    data: {
      labels,
      datasets: datasets.map(ds => ({
        ...ds,
        backgroundColor: ds.backgroundColor || CHART_THEME.colors.primary,
        borderColor: ds.borderColor || 'transparent',
        borderRadius: 8,
      })),
    },
    options: CHART_THEME.defaults,
  };
}
