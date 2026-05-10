import React from 'react';
import type { BillingStatus } from '../types';
import { openBillingPortal } from '../services/billingService';

interface SettingsProps {
  // AI Settings
  temperature: number;
  onTemperatureChange: (value: number) => void;
  
  // Appearance
  themePreference: 'system' | 'light' | 'dark';
  onThemeChange: (value: 'system' | 'light' | 'dark') => void;
  
  // Language
  language: string;
  onLanguageChange: (value: string) => void;
  
  // Navigation
  onClose?: () => void;
  
  // Billing
  billingStatus?: BillingStatus | null;
  onOpenPricing?: () => void;
}

const Settings: React.FC<SettingsProps> = ({
  temperature,
  onTemperatureChange,
  themePreference,
  onThemeChange,
  language,
  onLanguageChange,
  billingStatus,
  onOpenPricing
}) => {
  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      <div className="max-w-2xl mx-auto p-6 md:p-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-serif font-bold text-charcoal dark:text-white">Settings</h1>
          <p className="text-sm text-charcoal-muted dark:text-gray-400 mt-1">
            Customize your Horizon experience
          </p>
        </div>

        {/* Subscription Section */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-charcoal-muted dark:text-gray-400 uppercase tracking-wider mb-4">
            Subscription
          </h2>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
            {/* Plan Info */}
            <div className="p-4">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                  <svg className="w-5 h-5 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-medium text-charcoal dark:text-white">
                    {billingStatus?.plan?.displayName || 'No Plan'}
                  </h3>
                  <p className="text-xs text-charcoal-muted dark:text-gray-400 mt-0.5">
                    {billingStatus?.hasSubscription
                      ? `${billingStatus.status === 'active' ? 'Active' : billingStatus.status === 'trialing' ? 'Trial' : billingStatus.status} · ${billingStatus.billing?.cycle || 'Monthly'}`
                      : 'No active subscription'}
                  </p>
                </div>
                {billingStatus?.plan && (
                  <span className="text-sm font-semibold text-charcoal dark:text-white">
                    ${billingStatus.plan.priceMonthly.toLocaleString()}/mo
                  </span>
                )}
              </div>

              {/* Credit Usage */}
              {billingStatus?.credits && (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-charcoal-muted dark:text-gray-400">Credits used</span>
                    <span className="text-xs font-medium text-charcoal dark:text-gray-300">
                      {billingStatus.credits.used.toLocaleString()} / {billingStatus.credits.limit.toLocaleString()}
                    </span>
                  </div>
                  <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        billingStatus.credits.percent >= 90 ? 'bg-red-500' : billingStatus.credits.percent >= 70 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(billingStatus.credits.percent, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-charcoal-muted dark:text-gray-500 mt-1">
                    Resets {new Date(billingStatus.credits.resetDate).toLocaleDateString()}
                  </p>
                </div>
              )}

              {/* Usage Stats */}
              {billingStatus?.usage && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="p-2 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <p className="text-xs text-charcoal-muted dark:text-gray-400">Team Members</p>
                    <p className="text-sm font-medium text-charcoal dark:text-white">{billingStatus.usage.members} / {billingStatus.usage.maxMembers}</p>
                  </div>
                  <div className="p-2 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <p className="text-xs text-charcoal-muted dark:text-gray-400">Documents</p>
                    <p className="text-sm font-medium text-charcoal dark:text-white">{billingStatus.usage.documents} / {billingStatus.usage.maxDocuments}</p>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="mt-4 flex gap-2">
                {billingStatus?.hasSubscription && billingStatus.billing?.hasStripeSubscription && (
                  <button
                    onClick={() => openBillingPortal()}
                    className="flex-1 px-3 py-2 text-xs font-medium text-charcoal dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
                  >
                    Manage Billing
                  </button>
                )}
                <button
                  onClick={onOpenPricing}
                  className="flex-1 px-3 py-2 text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-lg transition-colors"
                >
                  {billingStatus?.hasSubscription ? 'Change Plan' : 'Choose a Plan'}
                </button>
              </div>

              {/* Next billing */}
              {billingStatus?.billing?.currentPeriodEnd && (
                <p className="text-xs text-charcoal-muted dark:text-gray-500 mt-3">
                  {billingStatus.billing.canceledAt
                    ? `Cancels on ${new Date(billingStatus.billing.currentPeriodEnd).toLocaleDateString()}`
                    : `Next billing: ${new Date(billingStatus.billing.currentPeriodEnd).toLocaleDateString()}`}
                </p>
              )}
            </div>
          </div>
        </section>

        {/* AI Behavior Section */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-charcoal-muted dark:text-gray-400 uppercase tracking-wider mb-4">
            AI Behavior
          </h2>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
            {/* Temperature / Creativity */}
            <div className="p-4">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                  <svg className="w-5 h-5 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-sm font-medium text-charcoal dark:text-white">Response Creativity</h3>
                    <span className="text-sm font-mono text-charcoal-muted dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded shrink-0 mt-0.5">
                      {temperature.toFixed(1)}
                    </span>
                  </div>
                  <p className="text-xs text-charcoal-muted dark:text-gray-400 mt-1 pr-1">
                    Lower for precise answers, higher for creative responses
                  </p>
                </div>
              </div>
              <div className="pl-13">
                <input
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => onTemperatureChange(parseFloat(e.target.value))}
                  className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                />
                <div className="flex justify-between text-xs text-charcoal-muted dark:text-gray-500 mt-1">
                  <span>Precise</span>
                  <span>Balanced</span>
                  <span>Creative</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Appearance Section */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-charcoal-muted dark:text-gray-400 uppercase tracking-wider mb-4">
            Appearance
          </h2>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
            {/* Theme */}
            <div className="p-5">
              <div className="flex items-start gap-3 mb-5">
                <div className="w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                  <svg className="w-5 h-5 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-charcoal dark:text-white">Theme</h3>
                  <p className="text-xs text-charcoal-muted dark:text-gray-400">
                    Choose how Horizon looks. System syncs with your operating system.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {([
                  {
                    value: 'system' as const,
                    label: 'System',
                    description: 'Auto',
                    icon: (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                    ),
                    preview: (
                      <div className="w-full h-14 rounded-md overflow-hidden relative border border-gray-200 dark:border-gray-600 mb-2.5">
                        <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #f8f9fa 50%, #1f2937 50%)' }} />
                        <div className="absolute top-1.5 left-1.5 w-5 h-1 rounded-full bg-gray-300" />
                        <div className="absolute top-4 left-1.5 w-3.5 h-0.5 rounded-full bg-gray-200" />
                        <div className="absolute bottom-1.5 right-1.5 w-5 h-1 rounded-full bg-gray-600" />
                        <div className="absolute bottom-4 right-1.5 w-3.5 h-0.5 rounded-full bg-gray-500" />
                      </div>
                    ),
                  },
                  {
                    value: 'light' as const,
                    label: 'Light',
                    description: 'Always',
                    icon: (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                      </svg>
                    ),
                    preview: (
                      <div className="w-full h-14 rounded-md overflow-hidden relative border border-gray-200 dark:border-gray-600 bg-white mb-2.5">
                        <div className="absolute top-2 left-2 right-2 h-1.5 rounded-full bg-gray-200" />
                        <div className="absolute top-5 left-2 w-2/3 h-1 rounded-full bg-gray-100" />
                        <div className="absolute bottom-2 left-2 right-2 flex gap-1">
                          <div className="flex-1 h-2.5 rounded bg-gray-100" />
                          <div className="flex-1 h-2.5 rounded bg-gray-100" />
                        </div>
                      </div>
                    ),
                  },
                  {
                    value: 'dark' as const,
                    label: 'Dark',
                    description: 'Always',
                    icon: (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                      </svg>
                    ),
                    preview: (
                      <div className="w-full h-14 rounded-md overflow-hidden relative border border-gray-600 bg-gray-900 mb-2.5">
                        <div className="absolute top-2 left-2 right-2 h-1.5 rounded-full bg-gray-700" />
                        <div className="absolute top-5 left-2 w-2/3 h-1 rounded-full bg-gray-800" />
                        <div className="absolute bottom-2 left-2 right-2 flex gap-1">
                          <div className="flex-1 h-2.5 rounded bg-gray-800" />
                          <div className="flex-1 h-2.5 rounded bg-gray-800" />
                        </div>
                      </div>
                    ),
                  },
                ] as const).map(({ value, label, description, icon, preview }) => (
                  <button
                    key={value}
                    onClick={() => onThemeChange(value)}
                    className={`group relative flex flex-col items-center p-3 rounded-xl border-2 transition-all duration-200 ${
                      themePreference === value
                        ? 'border-indigo-500 dark:border-indigo-400 bg-indigo-50/50 dark:bg-indigo-900/20 shadow-sm shadow-indigo-500/10'
                        : 'border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 hover:border-gray-300 dark:hover:border-gray-500 hover:bg-gray-100 dark:hover:bg-gray-600'
                    }`}
                  >
                    {/* Selection indicator */}
                    {themePreference === value && (
                      <div className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-indigo-500 dark:bg-indigo-400 flex items-center justify-center shadow-sm">
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                    {/* Preview thumbnail */}
                    {preview}
                    {/* Icon + Label */}
                    <div className={`flex items-center gap-1.5 text-xs font-semibold ${
                      themePreference === value
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-charcoal-muted dark:text-gray-400'
                    }`}>
                      {icon}
                      {label}
                    </div>
                    <span className={`text-[10px] mt-0.5 ${
                      themePreference === value
                        ? 'text-indigo-500/70 dark:text-indigo-400/60'
                        : 'text-charcoal-muted/60 dark:text-gray-500'
                    }`}>
                      {description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Language Section */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-charcoal-muted dark:text-gray-400 uppercase tracking-wider mb-4">
            Language
          </h2>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
            <div className="p-4">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                  <svg className="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-charcoal dark:text-white">Interface Language</h3>
                  <p className="text-xs text-charcoal-muted dark:text-gray-400">
                    Choose your preferred language
                  </p>
                </div>
              </div>
              <div className="relative">
                <select
                  value={language}
                  onChange={(e) => onLanguageChange(e.target.value)}
                  className="w-full appearance-none px-4 pr-10 py-3 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-charcoal dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                >
                  <option value="en">English</option>
                </select>
                <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-muted dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
              <p className="text-xs text-charcoal-muted dark:text-gray-500 mt-2">
                More languages coming soon
              </p>
            </div>
          </div>
        </section>

        {/* About Section */}
        <section>
          <h2 className="text-sm font-semibold text-charcoal-muted dark:text-gray-400 uppercase tracking-wider mb-4">
            About
          </h2>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center gap-3">
              <img src="/horizon-logo-white.webp" alt="Horizon Logo" width={48} height={48} decoding="async" loading="lazy" className="w-12 h-12 rounded-xl dark:hidden" />
              <img src="/horizon-logo-black.webp" alt="Horizon Logo" width={48} height={48} decoding="async" loading="lazy" className="w-12 h-12 rounded-xl hidden dark:block" />
              <div>
                <h3 className="text-sm font-semibold text-charcoal dark:text-white">Horizon Legal AI</h3>
                <p className="text-xs text-charcoal-muted dark:text-gray-400">Version 1.0.0</p>
              </div>
            </div>
            <p className="text-xs text-charcoal-muted dark:text-gray-400 mt-4">
              Horizon is an AI-powered legal research assistant designed to help legal professionals analyze documents, extract insights, and prepare case materials more efficiently.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
};

export default Settings;
