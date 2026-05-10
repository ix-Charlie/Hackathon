/**
 * TimelineChart — Interactive timeline of events using Recharts
 * Replaces/augments the CSS-only timeline in IntelligenceDashboard
 */

import React, { useMemo } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

interface TimelineEntry {
  date: string;
  type: string;
  category: string;
  description: string;
  source_file_id?: string;
}

interface TimelineChartProps {
  events: TimelineEntry[];
}

const TYPE_COLORS: Record<string, string> = {
  deadline: '#ef4444',
  filing: '#3b82f6',
  hearing: '#8b5cf6',
  contract: '#f59e0b',
  event: '#10b981',
  obligation: '#f97316',
  default: '#6b7280',
};

const CATEGORY_LABELS: Record<string, number> = {};
let nextY = 1;

function getCategoryY(cat: string): number {
  if (!(cat in CATEGORY_LABELS)) {
    CATEGORY_LABELS[cat] = nextY++;
  }
  return CATEGORY_LABELS[cat];
}

function getColor(type: string): string {
  return TYPE_COLORS[type?.toLowerCase()] || TYPE_COLORS.default;
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-3 py-2 max-w-xs">
      <p className="text-xs font-semibold text-gray-900 dark:text-white">{d.description}</p>
      <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">{d.date} · {d.type} · {d.category}</p>
    </div>
  );
};

const TimelineChart: React.FC<TimelineChartProps> = ({ events }) => {
  // Reset category mapping
  Object.keys(CATEGORY_LABELS).forEach(k => delete CATEGORY_LABELS[k]);
  nextY = 1;

  const data = useMemo(() => {
    return events
      .filter(e => e.date)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map(e => ({
        ...e,
        x: new Date(e.date).getTime(),
        y: getCategoryY(e.category || e.type || 'event'),
      }));
  }, [events]);

  const categories = useMemo(() => {
    return Object.entries(CATEGORY_LABELS)
      .sort((a, b) => a[1] - b[1])
      .map(([name]) => name);
  }, [data]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400 dark:text-gray-500 text-sm">
        No dated events to display.
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        {Object.entries(TYPE_COLORS)
          .filter(([k]) => k !== 'default')
          .map(([type, color]) => (
            <span key={type} className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </span>
          ))}
      </div>
      <ResponsiveContainer width="100%" height={Math.max(200, categories.length * 60 + 60)}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 80 }}>
          <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
          <XAxis
            type="number"
            dataKey="x"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}
            tick={{ fontSize: 10, fill: '#9ca3af' }}
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={[0.5, categories.length + 0.5]}
            ticks={categories.map((_, i) => i + 1)}
            tickFormatter={(v: number) => categories[v - 1] || ''}
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            width={70}
          />
          <Tooltip content={<CustomTooltip />} />
          <Scatter data={data} fill="#8884d8">
            {data.map((entry, idx) => (
              <Cell key={idx} fill={getColor(entry.type)} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
};

export default TimelineChart;
