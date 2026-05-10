import React, { useState } from 'react';
import Button from './Button';

interface BookACallPageProps {
  onBackToHome?: () => void;
  onBackToLogin?: () => void;
}

const BookACallPage: React.FC<BookACallPageProps> = ({ onBackToHome, onBackToLogin }) => {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    countryCode: '+92',
    phone: '',
    organizationName: '',
    practiceType: '',
    message: ''
  });
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const countryCodes = [
    { code: '+92', country: 'Pakistan', flag: '🇵🇰' },
    { code: '+1', country: 'United States', flag: '🇺🇸' },
    { code: '+44', country: 'United Kingdom', flag: '🇬🇧' },
    { code: '+971', country: 'UAE', flag: '🇦🇪' },
    { code: '+966', country: 'Saudi Arabia', flag: '🇸🇦' },
    { code: '+91', country: 'India', flag: '🇮🇳' },
    { code: '+86', country: 'China', flag: '🇨🇳' },
    { code: '+61', country: 'Australia', flag: '🇦🇺' },
    { code: '+49', country: 'Germany', flag: '🇩🇪' },
    { code: '+33', country: 'France', flag: '🇫🇷' },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const fullPhone = formData.phone ? `${formData.countryCode} ${formData.phone}` : '';
      const submissionData = {
        ...formData,
        fullPhone,
        submittedAt: new Date().toISOString()
      };

      // TODO: For production, replace this with a backend API call
      // Option 1: Create a Supabase Edge Function
      // Option 2: Use EmailJS service
      // Option 3: Create a backend endpoint
      
      // Temporary: Log to console and send notification
      console.log('Demo Request Submitted:', submissionData);

      // Send email using a backend service (implement in production)
      // Example: 
      // await fetch('/api/send-demo-request', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({ 
      //     to: 'syedhishamshah7@gmail.com',
      //     data: submissionData 
      //   })
      // });

      // For now, create an email draft
      const emailBody = `New Demo Request from Horizon\n\nName: ${formData.firstName} ${formData.lastName}\nEmail: ${formData.email}\nPhone: ${fullPhone}\nOrganization: ${formData.organizationName}\nPractice Type: ${formData.practiceType}\nMessage: ${formData.message || 'N/A'}\n\nSubmitted: ${new Date().toLocaleString()}`;
      
      // Store in localStorage as backup
      const existingRequests = JSON.parse(localStorage.getItem('demo_requests') || '[]');
      existingRequests.push(submissionData);
      localStorage.setItem('demo_requests', JSON.stringify(existingRequests));

      await new Promise(resolve => setTimeout(resolve, 1000));
      setIsSubmitted(true);
      
      // Alert you to check console/localStorage for now
      console.log('📧 Email should be sent to: syedhishamshah7@gmail.com');
      console.log('📝 Request data:', submissionData);
    } catch (error) {
      console.error('Error submitting form:', error);
      alert('There was an error submitting your request. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  if (isSubmitted) {
    return (
      <div className="min-h-screen w-full bg-white dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-10 h-10 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-3xl font-bold text-charcoal dark:text-white mb-4">Thank You!</h2>
          <p className="text-charcoal-muted dark:text-gray-400 mb-8">
            We've received your request. Our team will contact you within 24 hours to schedule your personalized demo.
          </p>
          <button
            onClick={onBackToHome}
            className="px-8 py-3 bg-steel-blue text-white rounded-lg font-medium hover:bg-steel-blue-hover transition-all"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-white dark:bg-gray-900 flex items-center justify-center p-4">
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

      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src="/horizon-logo-white.webp" alt="Horizon Logo" width={48} height={48} decoding="async" fetchPriority="high" className="w-12 h-12 rounded-xl shadow-lg dark:hidden" />
            <img src="/horizon-logo-black.webp" alt="Horizon Logo" width={48} height={48} decoding="async" fetchPriority="high" className="w-12 h-12 rounded-xl shadow-lg hidden dark:block" />
            <span className="text-3xl font-bold text-charcoal dark:text-white">Horizon</span>
          </div>
          <h1 className="text-4xl font-bold text-charcoal dark:text-white mb-3">Schedule a Demo</h1>
          <p className="text-charcoal-muted dark:text-gray-400 text-lg">
            Let's discuss how Horizon can transform your legal practice
          </p>
        </div>

        {/* Form Card */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 border border-charcoal-border dark:border-gray-700">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Name Fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-charcoal dark:text-gray-200 mb-2">First Name *</label>
                <input
                  type="text"
                  name="firstName"
                  value={formData.firstName}
                  onChange={handleChange}
                  className="w-full p-4 bg-white dark:bg-gray-700 border border-charcoal-border dark:border-gray-600 rounded-lg text-charcoal-secondary dark:text-gray-200 focus:ring-2 focus:ring-steel-blue outline-none transition-all"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-charcoal dark:text-gray-200 mb-2">Last Name *</label>
                <input
                  type="text"
                  name="lastName"
                  value={formData.lastName}
                  onChange={handleChange}
                  className="w-full p-4 bg-white dark:bg-gray-700 border border-charcoal-border dark:border-gray-600 rounded-lg text-charcoal-secondary dark:text-gray-200 focus:ring-2 focus:ring-steel-blue outline-none transition-all"
                  required
                />
              </div>
            </div>

            {/* Contact Fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-charcoal dark:text-gray-200 mb-2">Email Address *</label>
                <input
                  type="email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  className="w-full p-4 bg-white dark:bg-gray-700 border border-charcoal-border dark:border-gray-600 rounded-lg text-charcoal-secondary dark:text-gray-200 focus:ring-2 focus:ring-steel-blue outline-none transition-all"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-charcoal dark:text-gray-200 mb-2">Phone Number</label>
                <div className="flex gap-2">
                  <select
                    name="countryCode"
                    value={formData.countryCode}
                    onChange={handleChange}
                    className="w-32 p-4 bg-white dark:bg-gray-700 border border-charcoal-border dark:border-gray-600 rounded-lg text-charcoal-secondary dark:text-gray-200 focus:ring-2 focus:ring-steel-blue outline-none transition-all appearance-none bg-no-repeat bg-[length:12px] bg-[center_right_1rem] cursor-pointer"
                    style={{
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236B7280'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`
                    }}
                  >
                    {countryCodes.map((country) => (
                      <option key={country.code} value={country.code}>
                        {country.flag} {country.code}
                      </option>
                    ))}
                  </select>
                  <input
                    type="tel"
                    name="phone"
                    value={formData.phone}
                    onChange={handleChange}
                    placeholder="3001234567"
                    className="flex-1 p-4 bg-white dark:bg-gray-700 border border-charcoal-border dark:border-gray-600 rounded-lg text-charcoal-secondary dark:text-gray-200 focus:ring-2 focus:ring-steel-blue outline-none transition-all"
                  />
                </div>
              </div>
            </div>

            {/* Organization Fields */}
            <div>
              <label className="block text-sm font-medium text-charcoal dark:text-gray-200 mb-2">Organization/Firm Name *</label>
              <input
                type="text"
                name="organizationName"
                value={formData.organizationName}
                onChange={handleChange}
                placeholder="e.g., Smith & Associates"
                className="w-full p-4 bg-white dark:bg-gray-700 border border-charcoal-border dark:border-gray-600 rounded-lg text-charcoal-secondary dark:text-gray-200 focus:ring-2 focus:ring-steel-blue outline-none transition-all"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-charcoal dark:text-gray-200 mb-2">Practice Type *</label>
              <select
                name="practiceType"
                value={formData.practiceType}
                onChange={handleChange}
                className="w-full p-4 bg-white dark:bg-gray-700 border border-charcoal-border dark:border-gray-600 rounded-lg text-charcoal-secondary dark:text-gray-200 focus:ring-2 focus:ring-steel-blue outline-none transition-all appearance-none bg-no-repeat bg-[length:12px] bg-[center_right_1rem] cursor-pointer"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236B7280'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`
                }}
                required
              >
                <option value="">Select your practice type</option>
                <option value="law_firm">Law Firm</option>
                <option value="solo_practitioner">Solo Practitioner</option>
                <option value="corporate_legal">Corporate Legal Department</option>
                <option value="government">Government/Public Sector</option>
                <option value="other">Legal Tech/Other</option>
              </select>
            </div>

            {/* Message */}
            <div>
              <label className="block text-sm font-medium text-charcoal dark:text-gray-200 mb-2">Tell us about your needs (Optional)</label>
              <textarea
                name="message"
                value={formData.message}
                onChange={handleChange}
                rows={4}
                placeholder="What challenges are you facing? What features interest you most?"
                className="w-full p-4 bg-white dark:bg-gray-700 border border-charcoal-border dark:border-gray-600 rounded-lg text-charcoal-secondary dark:text-gray-200 focus:ring-2 focus:ring-steel-blue outline-none transition-all resize-none"
              />
            </div>

            {/* Submit Button */}
            <Button 
              type="submit" 
              isLoading={isLoading} 
              className="w-full py-4 !bg-steel-blue hover:!bg-steel-blue-hover !text-white shadow-lg"
            >
              Submit Request
            </Button>

            <p className="text-xs text-center text-charcoal-muted dark:text-gray-500 mt-4">
              By submitting this form, you agree to be contacted by our team regarding Horizon.
            </p>
          </form>

          {/* Back to Login Link */}
          {onBackToLogin && (
            <div className="mt-6 pt-6 border-t border-charcoal-border dark:border-gray-700 text-center">
              <p className="text-sm text-charcoal-muted dark:text-gray-400">
                Already have an account?{' '}
                <button 
                  onClick={onBackToLogin}
                  className="text-steel-blue dark:text-indigo-bright hover:text-steel-blue-hover dark:hover:text-indigo-bright-hover font-semibold hover:underline"
                >
                  Sign In
                </button>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BookACallPage;
