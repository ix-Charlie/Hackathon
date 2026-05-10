import React, { useState } from 'react';
import { signIn, resetPasswordForEmail } from '../services/authService';
import Button from './Button';
import BookACallPage from './BookACallPage';

interface AuthPageProps {
  onAuthSuccess: () => void;
  onBackToHome?: () => void;
  initialMode?: 'login' | 'book-call';
}

const AuthPage: React.FC<AuthPageProps> = ({ onAuthSuccess, onBackToHome, initialMode = 'login' }) => {
  const [isLogin, setIsLogin] = useState(initialMode === 'login'); // true = Login, false = Book a Call
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<{message: string, type: 'error' | 'success' | 'info'} | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      if (isForgotPassword) {
        await resetPasswordForEmail(email);
        setError({
          message: "Password reset link sent! Please check your email inbox.",
          type: 'success'
        });
      } else {
        await signIn(email, password);
        onAuthSuccess();
      }
    } catch (err: any) {
      if (err.message?.toLowerCase().includes("invalid login credentials")) {
        setError({
          message: "Invalid email or password. Please try again.",
          type: 'error'
        });
      } else {
        setError({
           message: err.message || "An authentication error occurred.",
           type: 'error'
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMode = () => {
    setError(null);
    setIsLogin(!isLogin);
    setPassword('');
    setShowPassword(false);
    setIsForgotPassword(false);
  };

  // If in Book a Call mode, show the BookACallPage component
  if (!isLogin) {
    return <BookACallPage onBackToHome={onBackToHome} onBackToLogin={toggleMode} />;
  }

  return (
    <div className="min-h-screen w-full bg-white dark:bg-gray-900 flex items-center justify-center p-4 transition-colors duration-500 relative">
      
      {/* Back Button */}
      {onBackToHome && (
        <button 
          onClick={onBackToHome}
          className="absolute top-6 left-6 flex items-center gap-2 text-charcoal-muted dark:text-gray-400 hover:text-steel-blue dark:hover:text-indigo-bright transition-colors z-20"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          <span className="font-medium text-sm hidden sm:inline">Back to Home</span>
        </button>
      )}

      <div className="w-full max-w-md">
        {/* Horizon Branding Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src="/horizon-logo-white.webp" alt="Horizon Logo" width={48} height={48} decoding="async" fetchPriority="high" className="w-12 h-12 rounded-xl shadow-lg dark:hidden" />
            <img src="/horizon-logo-black.webp" alt="Horizon Logo" width={48} height={48} decoding="async" fetchPriority="high" className="w-12 h-12 rounded-xl shadow-lg hidden dark:block" />
            <span className="text-3xl font-bold text-charcoal dark:text-white">Horizon</span>
          </div>
          <p className="text-charcoal-muted dark:text-gray-400 text-sm">Your Private AI Legal Associate</p>
        </div>

        {/* Auth Form Card */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 border border-charcoal-border dark:border-gray-700">
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-charcoal dark:text-white mb-2">
              {isForgotPassword ? "Reset Password" : "Welcome Back"}
            </h2>
            <p className="text-charcoal-muted dark:text-gray-400 text-sm">
              {isForgotPassword 
                ? "Enter your email to receive a reset link." 
                : "Sign in to continue to your case files."}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="Email Address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full p-4 bg-white dark:bg-gray-700 border border-charcoal-border dark:border-gray-600 rounded-lg text-charcoal-secondary dark:text-gray-200 focus:ring-2 focus:ring-steel-blue outline-none transition-all placeholder-charcoal-muted dark:placeholder-gray-500"
                required
              />
            </div>
            
            {!isForgotPassword && (
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full p-4 pr-12 bg-white dark:bg-gray-700 border border-charcoal-border dark:border-gray-600 rounded-lg text-charcoal-secondary dark:text-gray-200 focus:ring-2 focus:ring-steel-blue outline-none transition-all placeholder-charcoal-muted dark:placeholder-gray-500"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-charcoal-muted dark:text-gray-400 hover:text-charcoal-secondary dark:hover:text-gray-300 transition-colors"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            )}

            {!isForgotPassword && (
              <div className="flex justify-end">
                <button 
                  type="button"
                  onClick={() => { setError(null); setIsForgotPassword(true); }}
                  className="text-sm text-steel-blue dark:text-indigo-bright hover:text-steel-blue-hover dark:hover:text-indigo-bright-hover hover:underline font-medium"
                >
                  Forgot Password?
                </button>
              </div>
            )}

            {error && (
              <div className={`p-3 rounded text-sm ${
                error.type === 'success' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800' :
                error.type === 'info' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800' :
                'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800'
              }`}>
                {error.message}
              </div>
            )}

            <Button 
              type="submit" 
              isLoading={isLoading} 
              className="w-full py-4 !bg-steel-blue hover:!bg-steel-blue-hover !text-white shadow-lg"
            >
              {isForgotPassword ? "Send Reset Link" : "Sign In"}
            </Button>

            {isForgotPassword && (
              <button 
                type="button"
                onClick={() => { setError(null); setIsForgotPassword(false); }}
                className="w-full text-center text-sm text-charcoal-muted dark:text-gray-400 hover:text-charcoal-secondary dark:hover:text-gray-300 mt-4"
              >
                Back to Sign In
              </button>
            )}
          </form>

          {/* Toggle to Book a Call */}
          {!isForgotPassword && (
            <div className="mt-6 pt-6 border-t border-charcoal-border dark:border-gray-700 text-center">
              <p className="text-sm text-charcoal-muted dark:text-gray-400 mb-3">
                New to Horizon?
              </p>
              <button 
                type="button"
                onClick={toggleMode}
                className="w-full py-3 border-2 border-steel-blue dark:border-indigo-bright text-steel-blue dark:text-indigo-bright rounded-lg font-medium hover:bg-steel-blue-subtle dark:hover:bg-gray-700 transition-all"
              >
                Book a Demo Call
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AuthPage;
