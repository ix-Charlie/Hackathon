import React, { useState, useEffect } from 'react';
import Button from './Button';

interface LandingPageProps {
  onLoginClick: () => void;
  onBookCallClick: () => void;
  darkMode?: boolean;
  themePreference?: 'system' | 'light' | 'dark';
  onToggleDarkMode?: () => void;
}

const LandingPage: React.FC<LandingPageProps> = ({ onLoginClick, onBookCallClick, darkMode = false, themePreference = 'system', onToggleDarkMode }) => {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 font-sans text-charcoal dark:text-gray-100 selection:bg-steel-blue-subtle dark:selection:bg-indigo-bright/20">
      
      {/* --- Navigation --- */}
      <nav className={`fixed top-0 w-full z-50 transition-all duration-300 ${scrolled ? 'bg-white/90 dark:bg-gray-900/90 backdrop-blur-md shadow-sm border-b border-charcoal-border dark:border-gray-700 py-3' : 'bg-transparent py-5'}`}>
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <img src="/horizon-logo-white.webp" alt="Horizon Logo" width={32} height={32} decoding="async" fetchPriority="high" className="w-8 h-8 rounded-md dark:hidden" />
            <img src="/horizon-logo-black.webp" alt="Horizon Logo" width={32} height={32} decoding="async" fetchPriority="high" className="w-8 h-8 rounded-md hidden dark:block" />
            <span className="text-xl font-serif font-bold text-charcoal dark:text-white">Horizon</span>
          </div>

          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-charcoal-muted dark:text-gray-400">
            <button onClick={() => scrollToSection('features')} className="hover:text-steel-blue dark:hover:text-indigo-bright transition-colors">Features</button>
            <button onClick={() => scrollToSection('about')} className="hover:text-steel-blue dark:hover:text-indigo-bright transition-colors">About Us</button>
            <button onClick={() => scrollToSection('contact')} className="hover:text-steel-blue dark:hover:text-indigo-bright transition-colors">Contact</button>
          </div>

          <div className="flex items-center gap-3">
            {onToggleDarkMode && (
              <div className="relative group">
                <button
                  onClick={onToggleDarkMode}
                  className="relative p-2.5 rounded-xl border border-gray-200/60 dark:border-gray-700/60 bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-charcoal-muted dark:text-gray-400 hover:text-charcoal dark:hover:text-gray-200 transition-all duration-200 shadow-sm hover:shadow"
                  aria-label={`Theme: ${themePreference}. Click to switch.`}
                >
                  <div className="relative w-5 h-5">
                    {/* System icon */}
                    <svg className={`absolute inset-0 w-5 h-5 transition-all duration-300 ${themePreference === 'system' ? 'opacity-100 scale-100' : 'opacity-0 scale-75'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    {/* Light icon */}
                    <svg className={`absolute inset-0 w-5 h-5 transition-all duration-300 ${themePreference === 'light' ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-75 -rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                    {/* Dark icon */}
                    <svg className={`absolute inset-0 w-5 h-5 transition-all duration-300 ${themePreference === 'dark' ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-75 rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                    </svg>
                  </div>
                </button>
                {/* Tooltip */}
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2.5 py-1 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-[10px] font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none shadow-lg">
                  {themePreference === 'system' ? 'System theme' : themePreference === 'light' ? 'Light theme' : 'Dark theme'}
                  <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-900 dark:bg-gray-100 rotate-45" />
                </div>
              </div>
            )}
            <button 
              onClick={onLoginClick}
              className="text-sm font-medium text-charcoal-muted dark:text-gray-400 hover:text-steel-blue-hover dark:hover:text-indigo-bright"
            >
              Sign In
            </button>
            <Button onClick={onBookCallClick} className="!py-2 !px-5 !rounded-full shadow-lg shadow-charcoal/20">
              Book a Call
            </Button>
          </div>
        </div>
      </nav>

      {/* --- Hero Section --- */}
      <header className="relative pt-32 pb-20 lg:pt-48 lg:pb-32 overflow-hidden">
        
        <div className="max-w-4xl mx-auto px-6 relative z-10 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-steel-blue-subtle dark:bg-indigo-bright/10 border border-steel-blue dark:border-indigo-bright text-steel-blue dark:text-indigo-bright text-xs font-semibold uppercase tracking-wide mb-6">
            <span className="w-2 h-2 rounded-full bg-steel-blue dark:bg-indigo-bright animate-pulse"></span>
            NEW: GPT-5 TIER REASONING
          </div>
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-serif font-bold text-charcoal dark:text-white leading-tight mb-6">
            Your Private AI <br/>
            <span className="text-steel-blue dark:text-indigo-bright">Legal Associate</span>
          </h1>
          <p className="text-lg md:text-xl text-charcoal-muted dark:text-gray-400 mb-10 max-w-2xl mx-auto leading-relaxed">
            Horizon helps solo lawyers and small firms analyze case files, extract facts, and reason through complex documents in seconds. Secure, private, and precise.
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-4">
            <button 
              onClick={onBookCallClick}
              className="w-full sm:w-auto px-8 py-4 bg-slate-900 dark:bg-white text-white dark:text-gray-900 rounded-lg font-medium hover:bg-slate-800 dark:hover:bg-gray-100 transition-all shadow-xl hover:shadow-2xl hover:-translate-y-1"
            >
              Book a Call
            </button>
            <button 
              onClick={() => scrollToSection('features')}
              className="w-full sm:w-auto px-8 py-4 bg-white dark:bg-gray-800 text-slate-700 dark:text-gray-200 border border-charcoal-border dark:border-gray-600 rounded-lg font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-all"
            >
              See How It Works
            </button>
          </div>
        </div>
      </header>

      {/* --- Features Grid --- */}
      <section id="features" className="py-24 bg-white dark:bg-gray-900 border-y border-charcoal-border dark:border-gray-800">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-charcoal dark:text-white mb-4">Built for the Modern Attorney</h2>
            <p className="text-charcoal-muted dark:text-gray-400 max-w-2xl mx-auto">Focus on strategy while Horizon handles the document review. Designed to augment your legal expertise, not replace it.</p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {/* Feature 1 */}
            <div className="p-8 rounded-2xl bg-white dark:bg-gray-800 border border-charcoal-border dark:border-gray-700 hover:border-steel-blue dark:hover:border-indigo-bright transition-colors group">
              <div className="w-12 h-12 bg-white dark:bg-gray-900 rounded-xl border border-charcoal-border dark:border-gray-700 flex items-center justify-center mb-6 shadow-sm group-hover:scale-110 transition-transform text-steel-blue dark:text-indigo-bright">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              </div>
              <h3 className="text-xl font-semibold text-charcoal dark:text-white mb-3">Document Analysis</h3>
              <p className="text-charcoal-muted dark:text-gray-400 leading-relaxed">
                Upload PDFs, DOCX, or Excel files. Horizon reads them instantly, understanding context, dates, and legal clauses without hallucinating facts outside the record.
              </p>
            </div>

            {/* Feature 2 */}
            <div className="p-8 rounded-2xl bg-white dark:bg-gray-800 border border-charcoal-border dark:border-gray-700 hover:border-steel-blue dark:hover:border-indigo-bright transition-colors group">
              <div className="w-12 h-12 bg-white dark:bg-gray-900 rounded-xl border border-charcoal-border dark:border-gray-700 flex items-center justify-center mb-6 shadow-sm group-hover:scale-110 transition-transform text-steel-blue dark:text-indigo-bright">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
              </div>
              <h3 className="text-xl font-semibold text-charcoal dark:text-white mb-3">Private & Secure</h3>
              <p className="text-charcoal-muted dark:text-gray-400 leading-relaxed">
                Your client data is sacred. Files are processed in a secure environment and are never used to train public AI models.
              </p>
            </div>

            {/* Feature 3 */}
            <div className="p-8 rounded-2xl bg-white dark:bg-gray-800 border border-charcoal-border dark:border-gray-700 hover:border-steel-blue dark:hover:border-indigo-bright transition-colors group">
              <div className="w-12 h-12 bg-white dark:bg-gray-900 rounded-xl border border-charcoal-border dark:border-gray-700 flex items-center justify-center mb-6 shadow-sm group-hover:scale-110 transition-transform text-steel-blue dark:text-indigo-bright">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              </div>
              <h3 className="text-xl font-semibold text-charcoal dark:text-white mb-3">Instant Reasoning</h3>
              <p className="text-charcoal-muted dark:text-gray-400 leading-relaxed">
                Ask complex questions like "What are the termination conditions?" or "List all dates mentioned in the deposition" and get answers in seconds.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* --- About / Mission Section --- */}
      <section id="about" className="py-24 bg-slate-900 dark:bg-black text-slate-300 dark:text-gray-300">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center gap-16">
          <div className="md:w-1/2">
             <div className="w-full h-80 bg-charcoal dark:bg-gray-800 rounded-2xl p-8 flex items-center justify-center relative overflow-hidden">
                <div className="text-center relative z-10">
                  <div className="text-6xl font-serif font-bold text-white mb-2">10x</div>
                  <div className="text-xl uppercase tracking-widest text-slate-400 dark:text-gray-500">Faster Review</div>
                </div>
             </div>
          </div>
          <div className="md:w-1/2">
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-white mb-6">Empowering the Solo Practitioner</h2>
            <p className="text-lg leading-relaxed mb-6 text-slate-400 dark:text-gray-400">
              Large firms have armies of associates. You have Horizon. We believe that solo lawyers and boutique firms shouldn't be buried in paperwork. 
            </p>
            <p className="text-lg leading-relaxed mb-8 text-slate-400 dark:text-gray-400">
              Our mission is to level the playing field by providing affordable, high-powered AI that understands the nuances of legal documents, allowing you to represent your clients with the speed and precision of a 500-person firm.
            </p>
            <button onClick={onLoginClick} className="text-white border-b border-steel-blue pb-1 hover:text-steel-blue transition-colors">
              Read our full manifesto &rarr;
            </button>
          </div>
        </div>
      </section>

      {/* --- Contact / CTA Section --- */}
      <section id="contact" className="py-24 bg-steel-blue-subtle dark:bg-gray-800">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <h2 className="text-4xl font-serif font-bold text-charcoal dark:text-white mb-6">Ready to upgrade your practice?</h2>
          <p className="text-xl text-charcoal-muted dark:text-gray-300 mb-10">
            Schedule a personalized demo to see how Horizon can transform your legal practice.
          </p>
          <div className="flex justify-center gap-4">
             <button 
               onClick={onBookCallClick}
               className="px-10 py-4 bg-steel-blue dark:bg-white text-white dark:text-gray-900 rounded-lg font-bold shadow-lg shadow-steel-blue/30 dark:shadow-white/10 hover:bg-steel-blue-hover dark:hover:bg-gray-100 transition-all transform hover:scale-105"
             >
               Schedule a Demo
             </button>
          </div>
          <p className="mt-6 text-sm text-charcoal-muted dark:text-gray-400">Personalized onboarding • Expert guidance</p>
        </div>
      </section>

      {/* --- Footer --- */}
      <footer className="bg-white dark:bg-gray-900 pt-16 pb-8 border-t border-charcoal-border dark:border-gray-800">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid md:grid-cols-4 gap-12 mb-16">
            <div className="col-span-1 md:col-span-2">
              <div className="flex items-center gap-2 mb-4">
                <img src="/horizon-logo-white.webp" alt="Horizon Logo" width={32} height={32} decoding="async" loading="lazy" className="w-8 h-8 rounded-md dark:hidden" />
                <img src="/horizon-logo-black.webp" alt="Horizon Logo" width={32} height={32} decoding="async" loading="lazy" className="w-8 h-8 rounded-md hidden dark:block" />
                <span className="text-xl font-semibold text-charcoal dark:text-white">Horizon</span>
              </div>
              <p className="text-charcoal-muted dark:text-gray-400 max-w-sm">
                The AI legal associate designed for privacy, precision, and performance. helping you reason through the chaos.
              </p>
            </div>
            
            <div>
              <h4 className="font-bold text-charcoal dark:text-white mb-4">Product</h4>
              <ul className="space-y-2 text-sm text-charcoal-muted dark:text-gray-400">
                <li><button className="hover:text-steel-blue">Features</button></li>
                <li><button className="hover:text-steel-blue">Security</button></li>
                <li><button className="hover:text-steel-blue">Pricing</button></li>
                <li><button className="hover:text-steel-blue">Roadmap</button></li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-charcoal dark:text-white mb-4">Company</h4>
              <ul className="space-y-2 text-sm text-charcoal-muted dark:text-gray-400">
                <li><button className="hover:text-steel-blue">About Us</button></li>
                <li><button className="hover:text-steel-blue">Contact</button></li>
                <li><button className="hover:text-steel-blue">Privacy Policy</button></li>
                <li><button className="hover:text-steel-blue">Terms of Service</button></li>
              </ul>
            </div>
          </div>
          
          <div className="pt-8 border-t border-charcoal-border dark:border-gray-800 flex flex-col md:flex-row items-center justify-between text-sm text-slate-400 dark:text-gray-500">
            <p>&copy; {new Date().getFullYear()} Horizon AI. All rights reserved.</p>
            <div className="flex gap-6 mt-4 md:mt-0">
               <span>Made with precision for the law.</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;