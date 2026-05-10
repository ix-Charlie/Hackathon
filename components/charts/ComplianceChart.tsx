/**
 * ComplianceChart — PieChart for compliance status + upcoming obligations timeline
 */

import React, { useMemo } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
} from 'recharts';

interface ObligationItem {
  id: string;
  obligation_text: string;
  obligor?: string;
  obligee?: string;
  due_date?: string;
  status?: string;
  confidence?: number;
}

interface ComplianceChartProps {
  obligations: ObligationItem[];
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#22c55e',
  pending: '#eab308',
  overdue: '#dc2626',
  unknown: '#9ca3af',
};

const ComplianceChart: React.FC<ComplianceChartProps> = ({ obligations }) => {
  const statusData = useMemo(() => {
    const counts: Record<string, number> = { completed: 0, pending: 0, overdue: 0 };
    const now = new Date();
    for (const o of obligations) {
      const status = o.status?.toLowerCase();
      if (status === 'completed' || status === 'complete') {
        counts.completed++;
      } else if (o.due_date && new Date(o.due_date) < now) {
        counts.overdue++;
      } else {
        counts.pending++;
      }
    }
    return Object.entries(counts)
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        key: name,
        value,
      }));
  }, [obligations]);

  const complianceRate = useMemo(() => {
    if (obligations.length === 0) return 0;
    const completed = statusData.find(s => s.key === 'completed')?.value || 0;
    return Math.round((completed / obligations.length) * 100);
  }, [obligations, statusData]);

  // Obligations by responsible party (obligor)
  const partyData = useMemo(() => {
    const map = new Map<string, number>();
    for (const o of obligations) {
      const party = o.obligor || 'Unspecified';
      map.set(party, (map.get(party) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [obligations]);

  if (obligations.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400 dark:text-gray-500 text-sm">
        No obligations identified.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status pie + compliance rate */}
      <div className="flex items-center gap-6">
        <div className="w-36 h-36 relative">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={statusData}
                cx="50%"
                cy="50%"
                innerRadius="60%"
                outerRadius="85%"
                dataKey="value"
                stroke="none"
                paddingAngle={2}
              >
                {statusData.map(s => (
                  <Cell key={s.key} fill={STATUS_COLORS[s.key] || STATUS_COLORS.unknown} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ fontSize: 11, borderRadius: 8 }}
                formatter={(value: number) => [`${value}`, 'Obligations']}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-bold text-gray-900 dark:text-white">{complianceRate}%</span>
            <span className="text-[9px] text-gray-500 dark:text-gray-400">Compliance</span>
          </div>
        </div>
        <div className="flex-1 space-y-1">
          {statusData.map(s => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: STATUS_COLORS[s.key] }} />
              <span className="text-xs text-gray-600 dark:text-gray-300 flex-1">{s.name}</span>
              <span className="text-xs font-semibold text-gray-900 dark:text-white">{s.value}</span>
            </div>
          ))}
          <div className="pt-1 border-t border-gray-200 dark:border-gray-700 mt-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 dark:text-gray-400 flex-1">Total</span>
              <span className="text-xs font-semibold text-gray-900 dark:text-white">{obligations.length}</span>
            </div>
          </div>
        </div>
      </div>

      {/* By responsible party */}
      {partyData.length > 1 && (
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-2">By Responsible Party</h3>
          <ResponsiveContainer width="100%" height={partyData.length * 35 + 20}>
            <BarChart data={partyData} layout="vertical" margin={{ top: 0, right: 20, bottom: 0, left: 80 }}>
              <XAxis type="number" tick={{ fontSize: 10, fill: '#9ca3af' }} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#9ca3af' }} width={70} />
              <Tooltip
                contentStyle={{ fontSize: 11, borderRadius: 8 }}
                formatter={(value: number) => [`${value}`, 'Obligations']}
              />
              <Bar dataKey="count" fill="#6366f1" radius={[0, 4, 4, 0]} barSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
};

export default ComplianceChart;
