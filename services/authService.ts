import { supabase } from './supabaseClient';
import { APP_DOMAIN } from './config';

/**
 * Determines the correct redirect URL for email verifications.
 * Prioritizes APP_DOMAIN if set and we are on localhost (to support cross-device testing),
 * otherwise uses the current window origin.
 */
const getRedirectUrl = () => {
  // If APP_DOMAIN is configured and we are currently on localhost,
  // force the redirect to production so the email link works on mobile devices.
  if (APP_DOMAIN && window.location.hostname === 'localhost') {
    return APP_DOMAIN;
  }
  
  // Otherwise, use the current domain (e.g., the Vercel deployment)
  return window.location.origin;
};

/**
 * Validates email format
 */
const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Validates password strength
 */
const validatePassword = (password: string): { valid: boolean; error?: string } => {
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters long' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one lowercase letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one number' };
  }
  return { valid: true };
};

export const signIn = async (email: string, password: string) => {
  // Validate email format
  if (!isValidEmail(email)) {
    throw new Error('Invalid email format');
  }
  
  // Sanitize inputs
  const sanitizedEmail = email.trim().toLowerCase();
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email: sanitizedEmail,
    password,
  });
  if (error) throw error;
  return data;
};

export const signUp = async (
  email: string, 
  password: string, 
  userData?: {
    organizationName?: string;
    firstName?: string;
    lastName?: string;
    practiceType?: string;
  }
) => {
  // Validate email format
  if (!isValidEmail(email)) {
    throw new Error('Invalid email format');
  }
  
  // Validate password strength
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }
  
  // Sanitize inputs
  const sanitizedEmail = email.trim().toLowerCase();
  
  const { data, error } = await supabase.auth.signUp({
    email: sanitizedEmail,
    password,
    options: {
      emailRedirectTo: getRedirectUrl(),
      data: {
        organization_name: userData?.organizationName?.trim() || null,
        first_name: userData?.firstName?.trim() || null,
        last_name: userData?.lastName?.trim() || null,
        practice_type: userData?.practiceType || null,
      }
    }
  });
  if (error) throw error;
  
  // Check if user already exists (Supabase returns empty identities array for existing users)
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    throw new Error('User already registered');
  }
  
  return data;
};

export const signOut = async () => {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
};

export const getUser = async () => {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
};

export const resetPasswordForEmail = async (email: string) => {
  // Validate email format
  if (!isValidEmail(email)) {
    throw new Error('Invalid email format');
  }
  
  // Sanitize inputs
  const sanitizedEmail = email.trim().toLowerCase();
  
  const { data, error } = await supabase.auth.resetPasswordForEmail(sanitizedEmail, {
    redirectTo: getRedirectUrl(),
  });
  if (error) throw error;
  return data;
};