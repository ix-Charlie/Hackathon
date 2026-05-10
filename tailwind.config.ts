import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './index.html',
    './App.tsx',
    './index.tsx',
    './types.ts',
    './components/**/*.{ts,tsx}',
    './contexts/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        serif: ['Playfair Display', 'Georgia', 'serif'],
      },
      fontWeight: {
        normal: '400',
        medium: '500',
        semibold: '600',
        bold: '700',
      },
      letterSpacing: {
        tight: '-0.01em',
        normal: '0',
        wide: '0.01em',
      },
      transitionProperty: {
        'width': 'width',
        'spacing': 'margin, padding',
      },
      colors: {
        // Professional Legal Palette
        'charcoal': {
          DEFAULT: '#1F2933',
          secondary: '#374151',
          muted: '#6B7280',
          border: '#E5E7EB',
        },
        'steel-blue': {
          DEFAULT: '#1E3A8A',
          hover: '#1B3478',
          pressed: '#162B63',
          subtle: '#E8ECF6',
        },
        // Bright indigo accent for dark mode visibility
        'indigo-bright': {
          DEFAULT: '#7C87FF',
          hover: '#8A94FF',
          muted: '#6B7BFE',
        },
        'semantic': {
          success: '#166534',
          warning: '#92400E',
          error: '#991B1B',
        },
        // iOS-style Dark Mode (pure blacks, no blue tint)
        gray: {
          50: '#F9FAFB',
          100: '#F3F4F6',
          200: '#E5E7EB',
          300: '#D1D5DB',
          400: '#9CA3AF',
          500: '#6B7280',
          600: '#4B5563',
          700: '#2C2C2E',
          800: '#1C1C1E',
          900: '#000000',
        },
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { transform: 'scale(1)', opacity: '1' },
          '50%': { transform: 'scale(0.5)', opacity: '0.5' },
        },
        'slide-down': {
          '0%': { opacity: '0', maxHeight: '0', transform: 'translateY(-4px)' },
          '100%': { opacity: '1', maxHeight: '80px', transform: 'translateY(0)' },
        },
        'slide-up': {
          '0%': { opacity: '1', maxHeight: '80px', transform: 'translateY(0)' },
          '100%': { opacity: '0', maxHeight: '0', transform: 'translateY(-4px)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'scale-out': {
          '0%': { opacity: '1', transform: 'scale(1)' },
          '100%': { opacity: '0', transform: 'scale(0.95)' },
        },
        'message-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'card-in': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'cross-fade': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'backdrop-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateY(12px) scale(0.95)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'slide-out-right': {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'popover-in': {
          '0%': { opacity: '0', transform: 'scale(0.95) translateY(-4px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        'page-slide-left': {
          '0%': { opacity: '0', transform: 'translateX(60px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'page-slide-right': {
          '0%': { opacity: '0', transform: 'translateX(-60px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        fadeOut: {
          from: { opacity: '1', transform: 'translateY(0)' },
          to: { opacity: '0', transform: 'translateY(-4px)' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.2s ease-in-out infinite',
        'slide-down': 'slide-down 250ms cubic-bezier(0.4,0,0.2,1) forwards',
        'slide-up': 'slide-up 200ms cubic-bezier(0.4,0,0.2,1) forwards',
        'scale-in': 'scale-in 200ms cubic-bezier(0.4,0,0.2,1) forwards',
        'scale-out': 'scale-out 150ms cubic-bezier(0.4,0,0.2,1) forwards',
        'message-in': 'message-in 300ms cubic-bezier(0.4,0,0.2,1) forwards',
        'card-in': 'card-in 350ms cubic-bezier(0.4,0,0.2,1) forwards',
        'cross-fade': 'cross-fade 250ms cubic-bezier(0.4,0,0.2,1) forwards',
        'backdrop-in': 'backdrop-in 200ms ease-out forwards',
        'toast-in': 'toast-in 350ms cubic-bezier(0.4,0,0.2,1) forwards',
        'slide-in-right': 'slide-in-right 300ms cubic-bezier(0.4,0,0.2,1) forwards',
        'slide-out-right': 'slide-out-right 250ms cubic-bezier(0.4,0,0.2,1) forwards',
        'popover-in': 'popover-in 180ms cubic-bezier(0.4,0,0.2,1) forwards',
        'page-slide-left': 'page-slide-left 250ms cubic-bezier(0.4,0,0.2,1) forwards',
        'page-slide-right': 'page-slide-right 250ms cubic-bezier(0.4,0,0.2,1) forwards',
      },
    },
  },
  plugins: [],
};

export default config;
