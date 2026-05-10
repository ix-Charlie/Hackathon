# Email Notifications Setup for Book a Call

Demo requests are currently logged to console and localStorage. To receive emails at `syedhishamshah7@gmail.com`, implement one of these solutions:

## Option 1: EmailJS (Recommended - Free & Easy)

1. **Sign up at [EmailJS.com](https://www.emailjs.com/)**

2. **Create an email service** (Gmail, Outlook, etc.)

3. **Create an email template** with these variables:
   ```
   {{from_name}} requested a demo
   Name: {{first_name}} {{last_name}}
   Email: {{email}}
   Phone: {{phone}}
   Organization: {{organization}}
   Practice Type: {{practice_type}}
   Message: {{message}}
   ```

4. **Install EmailJS:**
   ```bash
   npm install @emailjs/browser
   ```

5. **Update BookACallPage.tsx:**
   ```typescript
   import emailjs from '@emailjs/browser';

   const handleSubmit = async (e: React.FormEvent) => {
     e.preventDefault();
     setIsLoading(true);

     try {
       await emailjs.send(
         'YOUR_SERVICE_ID',
         'YOUR_TEMPLATE_ID',
         {
           from_name: 'Horizon Demo Request',
           first_name: formData.firstName,
           last_name: formData.lastName,
           email: formData.email,
           phone: `${formData.countryCode} ${formData.phone}`,
           organization: formData.organizationName,
           practice_type: formData.practiceType,
           message: formData.message
         },
         'YOUR_PUBLIC_KEY'
       );
       
       setIsSubmitted(true);
     } catch (error) {
       console.error('Error:', error);
       alert('Failed to submit. Please try again.');
     } finally {
       setIsLoading(false);
     }
   };
   ```

## Option 2: Supabase Edge Function

1. **Create function:**
   ```bash
   supabase functions new send-demo-request
   ```

2. **Function code (supabase/functions/send-demo-request/index.ts):**
   ```typescript
   import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

   serve(async (req) => {
     const { data } = await req.json()
     
     // Send email using SendGrid, Resend, or SMTP
     const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
       method: 'POST',
       headers: {
         'Authorization': `Bearer ${Deno.env.get('SENDGRID_API_KEY')}`,
         'Content-Type': 'application/json'
       },
       body: JSON.stringify({
         personalizations: [{
           to: [{ email: 'syedhishamshah7@gmail.com' }]
         }],
         from: { email: 'noreply@horizon.com' },
         subject: `Demo Request - ${data.firstName} ${data.lastName}`,
         content: [{
           type: 'text/plain',
           value: `Name: ${data.firstName} ${data.lastName}\nEmail: ${data.email}\nPhone: ${data.fullPhone}\n...`
         }]
       })
     })

     return new Response(JSON.stringify({ success: true }), {
       headers: { 'Content-Type': 'application/json' }
     })
   })
   ```

3. **Deploy:**
   ```bash
   supabase functions deploy send-demo-request
   supabase secrets set SENDGRID_API_KEY=your_key
   ```

## Option 3: Simple Backend API

Create a backend endpoint (Node.js/Express) that sends emails using Nodemailer:

```javascript
// backend/routes/demo-request.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'your-app@gmail.com',
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

app.post('/api/send-demo-request', async (req, res) => {
  const { data } = req.body;
  
  await transporter.sendMail({
    from: 'noreply@horizon.com',
    to: 'syedhishamshah7@gmail.com',
    subject: `Demo Request - ${data.firstName} ${data.lastName}`,
    html: `<h2>New Demo Request</h2>
           <p><strong>Name:</strong> ${data.firstName} ${data.lastName}</p>
           <p><strong>Email:</strong> ${data.email}</p>
           <p><strong>Phone:</strong> ${data.fullPhone}</p>
           ...`
  });
  
  res.json({ success: true });
});
```

## Current Implementation

For now, demo requests are:
- ✅ Logged to browser console
- ✅ Saved to localStorage (check: `localStorage.getItem('demo_requests')`)
- ⏳ Email notification pending (implement above)

**Next Steps:**
1. Choose Option 1 (EmailJS) for quickest setup
2. Update `handleSubmit` in BookACallPage.tsx
3. Test the integration
4. Remove console.log statements
