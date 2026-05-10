/**
 * DecisionMatrix — Renders strategy/decision matrix tables from chat analysis
 * with optional impact×probability scatter visualization
 */

import React, { useMemo } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
  Label,
} from 'recharts';

export interface DecisionOption {
  label: string;
  impact: number;       // 1-10
  probability: number;  // 1-10
  effort?: number;      // 1-10 (optional, affects bubble size)
  category?: string;
}

interface DecisionMatrixProps {
  options: DecisionOption[];
  title?: string;
}

const QUADRANT_COLORS = {
  topRight: '#22c55e',    // High impact, high probability → Go
  topLeft: '#eab308',     // High impact, low probability → Investigate
  bottomRight: '#3b82f6', // Low impact, high probability → Quick win
  bottomLeft: '#9ca3af',  // Low impact, low probability → Skip
};

function getQuadrantColor(impact: number, probability: number): string {
  const midI = 5, midP = 5;
  if (impact >= midI && probability >= midP) return QUADRANT_COLORS.topRight;
  if (impact >= midI && probability < midP) return QUADRANT_COLORS.topLeft;
  if (impact < midI && probability >= midP) return QUADRANT_COLORS.bottomRight;
  return QUADRANT_COLORS.bottomLeft;
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as DecisionOption;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 shadow-lg text-xs">
      <div className="font-semibold text-gray-900 dark:text-white mb-1">{d.label}</div>
      <div className="text-gray-600 dark:text-gray-300">Impact: {d.impact}/10</div>
      <div className="text-gray-600 dark:text-gray-300">Probability: {d.probability}/10</div>
      {d.effort != null && <div className="text-gray-600 dark:text-gray-300">Effort: {d.effort}/10</div>}
      {d.category && <div className="text-gray-500 dark:text-gray-400 mt-1 italic">{d.category}</div>}
    </div>
  );
};

const DecisionMatrix: React.FC<DecisionMatrixProps> = ({ options, title }) => {
  const scatterData = useMemo(
    () => options.map(o => ({ ...o, z: o.effort ?? 5 })),
    [options],
  );

  if (options.length === 0) return null;

  return (
    <div className="space-y-3">
      {title && (
        <h3 className="text-sm font-medium text-gray-900 dark:text-white">{title}</h3>
      )}

      {/* Quadrant labels */}
      <div className="grid grid-cols-2 gap-1 text-[9px] text-center">
        <span className="text-yellow-600 dark:text-yellow-400">High Impact / Low Prob → Investigate</span>
        <span className="text-green-600 dark:text-green-400">High Impact / High Prob → Pursue</span>
        <span className="text-gray-400">Low Impact / Low Prob → Deprioritize</span>
        <span className="text-blue-500">Low Impact / High Prob → Quick Win</span>
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
          <XAxis
            dataKey="probability"
            type="number"
            domain={[0, 10]}
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            name="Probability"
          >
            <Label value="Probability →" position="bottom" offset={0} style={{ fontSize: 10, fill: '#9ca3af' }} />
          </XAxis>
          <YAxis
            dataKey="impact"
            type="number"
            domain={[0, 10]}
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            name="Impact"
          >
            <Label value="Impact →" angle={-90} position="left" offset={-5} style={{ fontSize: 10, fill: '#9ca3af' }} />
          </YAxis>
          <ZAxis dataKey="z" range={[60, 400]} name="Effort" />
          <ReferenceLine x={5} stroke="#e5e7eb" strokeDasharray="4 4" />
          <ReferenceLine y={5} stroke="#e5e7eb" strokeDasharray="4 4" />
          <Tooltip content={<CustomTooltip />} />
          <Scatter data={scatterData} name="Decision Options">
            {scatterData.map((entry, idx) => (
              <Cell key={idx} fill={getQuadrantColor(entry.impact, entry.probability)} fillOpacity={0.8} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>

      {/* Legend table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700">
              <th className="text-left py-1 pr-2 text-gray-500 dark:text-gray-400 font-medium">Option</th>
              <th className="text-center py-1 px-2 text-gray-500 dark:text-gray-400 font-medium">Impact</th>
              <th className="text-center py-1 px-2 text-gray-500 dark:text-gray-400 font-medium">Prob.</th>
              {options.some(o => o.effort != null) && (
                <th className="text-center py-1 px-2 text-gray-500 dark:text-gray-400 font-medium">Effort</th>
              )}
              <th className="text-center py-1 pl-2 text-gray-500 dark:text-gray-400 font-medium">Priority</th>
            </tr>
          </thead>
          <tbody>
            {[...options]
              .sort((a, b) => (b.impact * b.probability) - (a.impact * a.probability))
              .map(o => {
                const score = o.impact * o.probability;
                const tier = score >= 50 ? '⬆️ High' : score >= 25 ? '➡️ Med' : '⬇️ Low';
                return (
                  <tr key={o.label} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-1 pr-2 text-gray-900 dark:text-white">{o.label}</td>
                    <td className="py-1 px-2 text-center text-gray-600 dark:text-gray-300">{o.impact}</td>
                    <td className="py-1 px-2 text-center text-gray-600 dark:text-gray-300">{o.probability}</td>
                    {options.some(x => x.effort != null) && (
                      <td className="py-1 px-2 text-center text-gray-600 dark:text-gray-300">{o.effort ?? '—'}</td>
                    )}
                    <td className="py-1 pl-2 text-center">{tier}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default DecisionMatrix;
