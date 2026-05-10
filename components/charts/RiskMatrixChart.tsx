/**
 * RiskMatrixChart — Heatmap + gauge for risk assessment using Recharts
 */

import React, { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
} from 'recharts';

interface RiskItem {
  id: string;
  risk_description: string;
  severity: string;
  risk_type?: string;
  confidence?: number;
}

interface RiskMatrixChartProps {
  risks: RiskItem[];
  onFilterSeverity?: (severity: string | null) => void;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#eab308',
  low: '#22c55e',
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

const RiskMatrixChart: React.FC<RiskMatrixChartProps> = ({ risks, onFilterSeverity }) => {
  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of risks) {
      const s = r.severity?.toLowerCase() || 'low';
      if (s in counts) counts[s]++;
      else counts.low++;
    }
    return SEVERITY_ORDER.map(s => ({
      name: s.charAt(0).toUpperCase() + s.slice(1),
      key: s,
      count: counts[s],
      fill: SEVERITY_COLORS[s],
    }));
  }, [risks]);

  const typeCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of risks) {
      const t = r.risk_type || 'Other';
      map.set(t, (map.get(t) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [risks]);

  // Risk score gauge: weighted score 0-100
  const riskScore = useMemo(() => {
    if (risks.length === 0) return 0;
    const weights: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    let totalWeight = 0;
    for (const r of risks) {
      totalWeight += weights[r.severity?.toLowerCase()] || 1;
    }
    const maxPossible = risks.length * 4;
    return Math.round((totalWeight / maxPossible) * 100);
  }, [risks]);

  const gaugeData = [
    { name: 'Score', value: riskScore },
    { name: 'Remaining', value: 100 - riskScore },
  ];

  const gaugeColor = riskScore >= 75 ? '#dc2626' : riskScore >= 50 ? '#ea580c' : riskScore >= 25 ? '#eab308' : '#22c55e';

  if (risks.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400 dark:text-gray-500 text-sm">
        No risks identified.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Risk Score Gauge */}
      <div className="flex items-center gap-6">
        <div className="w-32 h-32 relative">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={gaugeData}
                cx="50%"
                cy="50%"
                startAngle={180}
                endAngle={0}
                innerRadius="70%"
                outerRadius="90%"
                dataKey="value"
                stroke="none"
              >
                <Cell fill={gaugeColor} />
                <Cell fill="#e5e7eb" />
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pt-4">
            <span className="text-2xl font-bold text-gray-900 dark:text-white">{riskScore}</span>
            <span className="text-[9px] text-gray-500 dark:text-gray-400">Risk Score</span>
          </div>
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-2">Severity Distribution</h3>
          <div className="grid grid-cols-2 gap-2">
            {severityCounts.map(s => (
              <button
                key={s.key}
                onClick={() => onFilterSeverity?.(s.key)}
                className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left"
              >
                <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: s.fill }} />
                <span className="text-xs text-gray-600 dark:text-gray-300">{s.name}</span>
                <span className="text-xs font-semibold text-gray-900 dark:text-white ml-auto">{s.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Risk by Type bar chart */}
      {typeCounts.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-2">Risks by Type</h3>
          <ResponsiveContainer width="100%" height={typeCounts.length * 35 + 20}>
            <BarChart data={typeCounts} layout="vertical" margin={{ top: 0, right: 20, bottom: 0, left: 100 }}>
              <XAxis type="number" tick={{ fontSize: 10, fill: '#9ca3af' }} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 10, fill: '#9ca3af' }}
                width={90}
              />
              <Tooltip
                contentStyle={{ fontSize: 11, borderRadius: 8 }}
                formatter={(value: number) => [`${value} risk(s)`, 'Count']}
              />
              <Bar dataKey="count" fill="#6366f1" radius={[0, 4, 4, 0]} barSize={18}>
                {typeCounts.map((_, idx) => (
                  <Cell key={idx} fill={idx < 2 ? '#ef4444' : idx < 4 ? '#f59e0b' : '#6366f1'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
};

export default RiskMatrixChart;
