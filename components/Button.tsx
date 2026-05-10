import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  isLoading?: boolean;
}

const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  isLoading = false, 
  className = '', 
  disabled,
  ...props 
}) => {
  const baseStyles = "px-4 py-2 rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 text-sm flex items-center justify-center gap-2";
  
  const variants = {
    primary: "bg-steel-blue text-white hover:bg-steel-blue-hover focus:ring-steel-blue",
    secondary: "bg-white dark:bg-gray-800 text-charcoal-secondary dark:text-gray-200 border border-charcoal-border dark:border-gray-600 hover:bg-steel-blue-subtle dark:hover:bg-gray-700 focus:ring-steel-blue",
    danger: "bg-red-50 dark:bg-red-900/20 text-semantic-error dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/30 focus:ring-semantic-error",
    ghost: "text-charcoal-muted dark:text-gray-400 hover:bg-steel-blue-subtle dark:hover:bg-gray-800 focus:ring-steel-blue"
  };

  return (
    <button 
      className={`${baseStyles} ${variants[variant]} ${disabled || isLoading ? 'opacity-50 cursor-not-allowed' : ''} ${className}`}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading ? (
        <>
          <svg className="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          Processing...
        </>
      ) : children}
    </button>
  );
};

export default Button;
