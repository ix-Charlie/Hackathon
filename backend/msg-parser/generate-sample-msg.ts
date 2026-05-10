/**
 * Generate a sample .msg file for testing
 * Uses the CFB (Compound File Binary) library to create a valid OLE2 .msg file
 * 
 * This script creates a realistic Outlook .msg file with:
 * - Subject, From, To, CC fields
 * - Date
 * - Plain text body
 * - HTML body
 * - A text file attachment
 * 
 * Run: npx tsx msg-parser/generate-sample-msg.ts
 */

import * as CFB from 'cfb';
import fs from 'fs';
import path from 'path';

// .msg Property IDs (Microsoft MAPI property tags):
// https://docs.microsoft.com/en-us/office/client-developer/outlook/mapi/mapi-property-tags

// Property types
const PT_UNICODE = 0x001F;  // Unicode string
const PT_STRING8 = 0x001E;  // ANSI string
const PT_BINARY  = 0x0102;  // Binary
const PT_LONG    = 0x0003;  // 32-bit integer
const PT_SYSTIME = 0x0040;  // FILETIME

// Property IDs
const PR_SUBJECT               = 0x0037;
const PR_SENDER_NAME           = 0x0C1A;
const PR_SENDER_EMAIL_ADDRESS  = 0x0C1F;
const PR_DISPLAY_TO            = 0x0E04;
const PR_DISPLAY_CC            = 0x0E03;
const PR_DISPLAY_BCC           = 0x0E02;
const PR_BODY                  = 0x1000;
const PR_BODY_HTML             = 0x1035;
const PR_CLIENT_SUBMIT_TIME    = 0x0039;
const PR_MESSAGE_DELIVERY_TIME = 0x0E06;
const PR_CREATION_TIME         = 0x3007;
const PR_RECIPIENT_TYPE        = 0x0C15;
const PR_DISPLAY_NAME          = 0x3001;
const PR_EMAIL_ADDRESS         = 0x3003;
const PR_SMTP_ADDRESS          = 0x39FE;
const PR_ATTACH_FILENAME       = 0x3704;
const PR_ATTACH_LONG_FILENAME  = 0x3707;
const PR_ATTACH_DATA_BIN       = 0x3701;
const PR_ATTACH_METHOD         = 0x3705;
const PR_MESSAGE_CLASS         = 0x001A;
const PR_ATTACH_MIME_TAG       = 0x370E;

function propTag(propId: number, propType: number): string {
  const tag = ((propId << 16) | propType).toString(16).toUpperCase().padStart(8, '0');
  return tag;
}

function unicodeStreamName(propId: number): string {
  return `__substg1.0_${propTag(propId, PT_UNICODE)}`;
}

function string8StreamName(propId: number): string {
  return `__substg1.0_${propTag(propId, PT_STRING8)}`;
}

function binaryStreamName(propId: number): string {
  return `__substg1.0_${propTag(propId, PT_BINARY)}`;
}

function longStreamName(propId: number): string {
  return `__substg1.0_${propTag(propId, PT_LONG)}`;
}

function toUTF16LE(str: string): Buffer {
  const buf = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16LE(str.charCodeAt(i), i * 2);
  }
  return buf;
}

// Create the sample email content
const subject = 'Quarterly Legal Review - Henderson v. TechCorp Case Update';
const fromName = 'Sarah Mitchell';
const fromEmail = 'sarah.mitchell@lawfirm-example.com';
const toDisplay = 'John Henderson; Lisa Park';
const toEmail1 = 'john.henderson@client-example.com';
const toEmail2 = 'lisa.park@lawfirm-example.com';
const ccDisplay = 'David Chen';
const ccEmail = 'david.chen@lawfirm-example.com';
const bccDisplay = 'Filing System';
const bccEmail = 'filing@lawfirm-example.com';

const dateStr = 'Mon, 10 Feb 2026 14:30:00 -0500';

const bodyText = `Dear Team,

I am writing to provide an update on the Henderson v. TechCorp case (Case No. 2025-CV-4892).

Key Developments:
1. Discovery Phase: We have completed the initial document review. Over 15,000 documents were processed through our review platform.
2. Expert Witnesses: Dr. Amanda Foster (Digital Forensics) and Prof. Robert Kim (Data Privacy) have both confirmed their availability for depositions scheduled in March 2026.
3. Settlement Discussions: Opposing counsel has indicated willingness to explore mediation. A preliminary settlement conference is scheduled for March 15, 2026.

Financial Summary:
- Current billable hours: 342.5 hours
- Outstanding invoices: $127,450.00
- Estimated remaining costs: $85,000 - $120,000

Action Items:
- John: Please review the attached document summary and confirm accuracy of the timeline.
- Lisa: Prepare the expert witness briefing packets by February 20, 2026.
- David: Update the case management system with the new deposition schedule.

Next Steps:
We will reconvene on February 24, 2026 to discuss our mediation strategy. Please come prepared with your recommended settlement parameters.

If you have any questions or concerns, please do not hesitate to reach out.

Best regards,
Sarah Mitchell, Esq.
Senior Partner | Mitchell & Associates
Phone: (555) 234-5678
Email: sarah.mitchell@lawfirm-example.com

CONFIDENTIALITY NOTICE: This email and any attachments are for the exclusive and confidential use of the intended recipient. If you are not the intended recipient, please do not read, distribute, or take action based on this message.`;

const bodyHtml = `<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<style>
body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #333333; }
.header { color: #1a5276; font-size: 14pt; font-weight: bold; }
.section { margin-top: 15px; }
.financial-table { border-collapse: collapse; margin: 10px 0; }
.financial-table td { padding: 4px 12px; border: 1px solid #ddd; }
.signature { color: #666; font-size: 9pt; margin-top: 20px; border-top: 1px solid #ccc; padding-top: 10px; }
.confidentiality { font-size: 8pt; color: #999; margin-top: 15px; font-style: italic; }
</style>
</head>
<body>
<p>Dear Team,</p>
<p class="header">Henderson v. TechCorp — Case Update</p>
<p>I am writing to provide an update on the <strong>Henderson v. TechCorp</strong> case (Case No. 2025-CV-4892).</p>
<div class="section">
<h3>Key Developments:</h3>
<ol>
<li><strong>Discovery Phase:</strong> We have completed the initial document review. Over 15,000 documents were processed through our review platform.</li>
<li><strong>Expert Witnesses:</strong> Dr. Amanda Foster (Digital Forensics) and Prof. Robert Kim (Data Privacy) have both confirmed their availability for depositions scheduled in March 2026.</li>
<li><strong>Settlement Discussions:</strong> Opposing counsel has indicated willingness to explore mediation. A preliminary settlement conference is scheduled for <em>March 15, 2026</em>.</li>
</ol>
</div>
<div class="section">
<h3>Financial Summary:</h3>
<table class="financial-table">
<tr><td>Current billable hours</td><td>342.5 hours</td></tr>
<tr><td>Outstanding invoices</td><td>$127,450.00</td></tr>
<tr><td>Estimated remaining costs</td><td>$85,000 - $120,000</td></tr>
</table>
</div>
<div class="section">
<h3>Action Items:</h3>
<ul>
<li><strong>John:</strong> Please review the attached document summary and confirm accuracy of the timeline.</li>
<li><strong>Lisa:</strong> Prepare the expert witness briefing packets by February 20, 2026.</li>
<li><strong>David:</strong> Update the case management system with the new deposition schedule.</li>
</ul>
</div>
<p>We will reconvene on <strong>February 24, 2026</strong> to discuss our mediation strategy.</p>
<div class="signature">
<p><strong>Sarah Mitchell, Esq.</strong><br>
Senior Partner | Mitchell &amp; Associates<br>
Phone: (555) 234-5678<br>
Email: <a href="mailto:sarah.mitchell@lawfirm-example.com">sarah.mitchell@lawfirm-example.com</a></p>
</div>
<div class="confidentiality">
<p>CONFIDENTIALITY NOTICE: This email and any attachments are for the exclusive and confidential use of the intended recipient. If you are not the intended recipient, please do not read, distribute, or take action based on this message.</p>
</div>
<img src="cid:tracking-pixel-12345" width="1" height="1" style="display:none">
</body>
</html>`;

const attachmentText = `DOCUMENT SUMMARY — Henderson v. TechCorp
Case No. 2025-CV-4892
Prepared: February 10, 2026

TIMELINE OF EVENTS:

2024-03-15: Initial complaint filed by Henderson
2024-04-02: TechCorp served with summons
2024-05-10: TechCorp files answer and counterclaim
2024-07-22: Initial case management conference
2024-09-01: Discovery begins
2025-01-15: First set of interrogatories served
2025-03-20: Document production deadline
2025-06-10: Expert reports due
2025-08-15: Depositions begin
2026-02-10: Current status update
2026-03-15: Settlement conference scheduled

KEY DOCUMENTS REVIEWED:
- Employment contract (2019)
- Non-disclosure agreement (2019)
- Performance reviews (2019-2024)
- Email communications (selected, 847 items)
- Internal memos re: Project Atlas (12 items)
- Financial records (Q1 2023 - Q4 2024)

Total pages reviewed: 15,247
Privileged documents identified: 342
Documents produced: 14,905
`;

function generateMsgFile(): void {
  // Create a new CFB container
  const cfb = CFB.utils.cfb_new();

  // Add message class
  const msgClassData = toUTF16LE('IPM.Note');
  CFB.utils.cfb_add(cfb, `/${unicodeStreamName(PR_MESSAGE_CLASS)}`, msgClassData);

  // Add Subject
  const subjectData = toUTF16LE(subject);
  CFB.utils.cfb_add(cfb, `/${unicodeStreamName(PR_SUBJECT)}`, subjectData);

  // Add Sender Name
  const senderNameData = toUTF16LE(fromName);
  CFB.utils.cfb_add(cfb, `/${unicodeStreamName(PR_SENDER_NAME)}`, senderNameData);

  // Add Sender Email
  const senderEmailData = toUTF16LE(fromEmail);
  CFB.utils.cfb_add(cfb, `/${unicodeStreamName(PR_SENDER_EMAIL_ADDRESS)}`, senderEmailData);

  // Add Display To
  const displayToData = toUTF16LE(toDisplay);
  CFB.utils.cfb_add(cfb, `/${unicodeStreamName(PR_DISPLAY_TO)}`, displayToData);

  // Add Display CC
  const displayCCData = toUTF16LE(ccDisplay);
  CFB.utils.cfb_add(cfb, `/${unicodeStreamName(PR_DISPLAY_CC)}`, displayCCData);

  // Add Display BCC
  const displayBCCData = toUTF16LE(bccDisplay);
  CFB.utils.cfb_add(cfb, `/${unicodeStreamName(PR_DISPLAY_BCC)}`, displayBCCData);

  // Add Body (plain text)
  const bodyData = toUTF16LE(bodyText);
  CFB.utils.cfb_add(cfb, `/${unicodeStreamName(PR_BODY)}`, bodyData);

  // Add Body HTML
  const htmlData = Buffer.from(bodyHtml, 'utf-8');
  CFB.utils.cfb_add(cfb, `/${string8StreamName(PR_BODY_HTML)}`, htmlData);

  // --- Recipient 0 (To: John Henderson) ---
  const recip0Dir = '/__recip_version1.0_#00000000';
  const recip0NameData = toUTF16LE('John Henderson');
  const recip0EmailData = toUTF16LE(toEmail1);
  const recip0SmtpData = toUTF16LE(toEmail1);
  const recip0Type = Buffer.alloc(4);
  recip0Type.writeUInt32LE(1); // MAPI_TO = 1
  CFB.utils.cfb_add(cfb, `${recip0Dir}/${unicodeStreamName(PR_DISPLAY_NAME)}`, recip0NameData);
  CFB.utils.cfb_add(cfb, `${recip0Dir}/${unicodeStreamName(PR_EMAIL_ADDRESS)}`, recip0EmailData);
  CFB.utils.cfb_add(cfb, `${recip0Dir}/${unicodeStreamName(PR_SMTP_ADDRESS)}`, recip0SmtpData);
  CFB.utils.cfb_add(cfb, `${recip0Dir}/${longStreamName(PR_RECIPIENT_TYPE)}`, recip0Type);

  // --- Recipient 1 (To: Lisa Park) ---
  const recip1Dir = '/__recip_version1.0_#00000001';
  const recip1NameData = toUTF16LE('Lisa Park');
  const recip1EmailData = toUTF16LE(toEmail2);
  const recip1SmtpData = toUTF16LE(toEmail2);
  const recip1Type = Buffer.alloc(4);
  recip1Type.writeUInt32LE(1); // MAPI_TO = 1
  CFB.utils.cfb_add(cfb, `${recip1Dir}/${unicodeStreamName(PR_DISPLAY_NAME)}`, recip1NameData);
  CFB.utils.cfb_add(cfb, `${recip1Dir}/${unicodeStreamName(PR_EMAIL_ADDRESS)}`, recip1EmailData);
  CFB.utils.cfb_add(cfb, `${recip1Dir}/${unicodeStreamName(PR_SMTP_ADDRESS)}`, recip1SmtpData);
  CFB.utils.cfb_add(cfb, `${recip1Dir}/${longStreamName(PR_RECIPIENT_TYPE)}`, recip1Type);

  // --- Recipient 2 (CC: David Chen) ---
  const recip2Dir = '/__recip_version1.0_#00000002';
  const recip2NameData = toUTF16LE('David Chen');
  const recip2EmailData = toUTF16LE(ccEmail);
  const recip2SmtpData = toUTF16LE(ccEmail);
  const recip2Type = Buffer.alloc(4);
  recip2Type.writeUInt32LE(2); // MAPI_CC = 2
  CFB.utils.cfb_add(cfb, `${recip2Dir}/${unicodeStreamName(PR_DISPLAY_NAME)}`, recip2NameData);
  CFB.utils.cfb_add(cfb, `${recip2Dir}/${unicodeStreamName(PR_EMAIL_ADDRESS)}`, recip2EmailData);
  CFB.utils.cfb_add(cfb, `${recip2Dir}/${unicodeStreamName(PR_SMTP_ADDRESS)}`, recip2SmtpData);
  CFB.utils.cfb_add(cfb, `${recip2Dir}/${longStreamName(PR_RECIPIENT_TYPE)}`, recip2Type);

  // --- Recipient 3 (BCC: Filing System) ---
  const recip3Dir = '/__recip_version1.0_#00000003';
  const recip3NameData = toUTF16LE('Filing System');
  const recip3EmailData = toUTF16LE(bccEmail);
  const recip3SmtpData = toUTF16LE(bccEmail);
  const recip3Type = Buffer.alloc(4);
  recip3Type.writeUInt32LE(3); // MAPI_BCC = 3
  CFB.utils.cfb_add(cfb, `${recip3Dir}/${unicodeStreamName(PR_DISPLAY_NAME)}`, recip3NameData);
  CFB.utils.cfb_add(cfb, `${recip3Dir}/${unicodeStreamName(PR_EMAIL_ADDRESS)}`, recip3EmailData);
  CFB.utils.cfb_add(cfb, `${recip3Dir}/${unicodeStreamName(PR_SMTP_ADDRESS)}`, recip3SmtpData);
  CFB.utils.cfb_add(cfb, `${recip3Dir}/${longStreamName(PR_RECIPIENT_TYPE)}`, recip3Type);

  // --- Attachment 0: Document Summary ---
  const attach0Dir = '/__attach_version1.0_#00000000';
  const attach0Name = toUTF16LE('Case_Summary_Henderson_v_TechCorp.txt');
  const attach0LongName = toUTF16LE('Case_Summary_Henderson_v_TechCorp.txt');
  const attach0Data = Buffer.from(attachmentText, 'utf-8');
  const attach0Method = Buffer.alloc(4);
  attach0Method.writeUInt32LE(1); // ATTACH_BY_VALUE = 1
  const attach0Mime = toUTF16LE('text/plain');

  CFB.utils.cfb_add(cfb, `${attach0Dir}/${unicodeStreamName(PR_ATTACH_FILENAME)}`, attach0Name);
  CFB.utils.cfb_add(cfb, `${attach0Dir}/${unicodeStreamName(PR_ATTACH_LONG_FILENAME)}`, attach0LongName);
  CFB.utils.cfb_add(cfb, `${attach0Dir}/${binaryStreamName(PR_ATTACH_DATA_BIN)}`, attach0Data);
  CFB.utils.cfb_add(cfb, `${attach0Dir}/${longStreamName(PR_ATTACH_METHOD)}`, attach0Method);
  CFB.utils.cfb_add(cfb, `${attach0Dir}/${unicodeStreamName(PR_ATTACH_MIME_TAG)}`, attach0Mime);

  // Write the CFB to a file
  const outputPath = path.join(import.meta.dirname, 'sample-email.msg');
  const cfbOutput = CFB.write(cfb, { type: 'buffer' }) as Buffer;
  fs.writeFileSync(outputPath, cfbOutput);

  console.log(`✅ Sample .msg file generated: ${outputPath}`);
  console.log(`   File size: ${cfbOutput.length} bytes`);
  console.log(`   Subject: ${subject}`);
  console.log(`   From: ${fromName} <${fromEmail}>`);
  console.log(`   To: ${toDisplay}`);
  console.log(`   CC: ${ccDisplay}`);
  console.log(`   BCC: ${bccDisplay}`);
  console.log(`   Attachment: Case_Summary_Henderson_v_TechCorp.txt`);
}

generateMsgFile();
