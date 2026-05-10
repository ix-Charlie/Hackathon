# Security Headers Configuration Guide

This document explains how to configure security headers for production deployment.

## 🛡️ Security Headers Explained

### 1. Content-Security-Policy (CSP)
**What it prevents:** XSS attacks, unauthorized script injection, data theft

**Current Policy:**
```
default-src 'self';
script-src 'self' https://cdn.tailwindcss.com;
style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com;
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self' https://*.supabase.co https://generativelanguage.googleapis.com;
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

**Recommendations:**
- Move Tailwind CSS to local build to remove `https://cdn.tailwindcss.com` from script-src
- Remove `'unsafe-inline'` from style-src after moving Tailwind locally
- Use `nonce` or `hash` for inline styles after removing CDN

### 2. X-Frame-Options: DENY
**What it prevents:** Clickjacking attacks where your site is embedded in malicious iframe

### 3. X-Content-Type-Options: nosniff
**What it prevents:** MIME-sniffing attacks where browser misinterprets file types

### 4. Referrer-Policy: strict-origin-when-cross-origin
**What it prevents:** Leaking sensitive URLs to third-party sites

### 5. Permissions-Policy
**What it prevents:** Unauthorized access to device features (camera, microphone, location)

### 6. Strict-Transport-Security (HSTS)
**What it prevents:** Man-in-the-middle attacks, forces HTTPS for 2 years

### 7. X-XSS-Protection: 1; mode=block
**What it prevents:** Legacy XSS attacks (modern browsers use CSP instead)

## 🚀 Deployment Configurations

### Vercel
The `vercel.json` file in the root automatically applies these headers to all routes.

No additional configuration needed!

### Netlify
Create `netlify.toml`:
```toml
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = "default-src 'self'; script-src 'self' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://*.supabase.co https://generativelanguage.googleapis.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "geolocation=(), microphone=(), camera=()"
    Strict-Transport-Security = "max-age=63072000; includeSubDomains; preload"
    X-XSS-Protection = "1; mode=block"
```

### Cloudflare Pages
Go to Pages > Your Project > Settings > Headers & Redirects

Add custom headers:
```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.tailwindcss.com; ...
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=()
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-XSS-Protection: 1; mode=block
```

### Apache (.htaccess)
```apache
<IfModule mod_headers.c>
    Header set Content-Security-Policy "default-src 'self'; script-src 'self' https://cdn.tailwindcss.com; ..."
    Header set X-Frame-Options "DENY"
    Header set X-Content-Type-Options "nosniff"
    Header set Referrer-Policy "strict-origin-when-cross-origin"
    Header set Permissions-Policy "geolocation=(), microphone=(), camera=()"
    Header set Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
    Header set X-XSS-Protection "1; mode=block"
</IfModule>
```

### Nginx
```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://cdn.tailwindcss.com; ..." always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-XSS-Protection "1; mode=block" always;
```

## 🧪 Testing Your Headers

### Online Tools
1. **Security Headers**: https://securityheaders.com/
2. **Mozilla Observatory**: https://observatory.mozilla.org/
3. **CSP Evaluator**: https://csp-evaluator.withgoogle.com/

### Browser DevTools
1. Open Network tab
2. Refresh page
3. Click on document request
4. Check "Response Headers" section
5. Verify all security headers are present

### Command Line
```bash
curl -I https://your-domain.com
```

Look for headers starting with `Content-Security-Policy`, `X-Frame-Options`, etc.

## 🔒 Best Practices

1. **Always use HTTPS in production** - Many headers require HTTPS to work properly
2. **Test CSP in Report-Only mode first** - Use `Content-Security-Policy-Report-Only` header to test without breaking the site
3. **Monitor CSP violations** - Set up a `report-uri` or `report-to` endpoint to collect violations
4. **Update CSP as you add features** - New third-party scripts need to be added to CSP
5. **Remove Tailwind CDN** - Build Tailwind locally for stricter CSP

## 📚 Additional Resources

- [OWASP Security Headers](https://owasp.org/www-project-secure-headers/)
- [MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)
- [Content Security Policy Reference](https://content-security-policy.com/)
