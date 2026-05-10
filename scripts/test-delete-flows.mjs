const SUPABASE_URL = 'https://ztjigmguhsihbtqhmwrx.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0amlnbWd1aHNpaGJ0cWhtd3J4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MTIwMzUsImV4cCI6MjA4MTM4ODAzNX0.DISNETtMFOWHzb8OAgomcZrFEKirEIPrUlAXx8psCWs';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0amlnbWd1aHNpaGJ0cWhtd3J4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTgxMjAzNSwiZXhwIjoyMDgxMzg4MDM1fQ.WWt1iut3hxCRto0PqPVnya9_IENGNYm4NNipTghf0Ko';
const EMAIL = 'hishamalix.amz@gmail.com';

const now = Date.now();
const CASE_NAME = `DeleteProbe_${now}`;
const FOLDER_NAME = `DeleteProbeFolder_${now}`;
const FILE_NAME = `DeleteProbeFile_${now}.txt`;
const CHAT_TITLE = `DeleteProbeChat_${now}`;

async function req(url, { method = 'GET', headers = {}, body } = {}) {
  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await resp.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = txt;
  }
  if (!resp.ok) {
    throw new Error(`${method} ${url} -> ${resp.status} ${txt}`);
  }
  return data;
}

async function getJwt() {
  const link = await req(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      'Content-Type': 'application/json',
    },
    body: { type: 'magiclink', email: EMAIL },
  });

  const otp = link?.email_otp;
  if (!otp) throw new Error('No OTP from generate_link');

  const session = await req(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: { type: 'magiclink', token: otp, email: EMAIL },
  });

  if (!session?.access_token || !session?.user?.id) {
    throw new Error('No access token from verify');
  }

  return { jwt: session.access_token, userId: session.user.id };
}

function userHeaders(jwt) {
  return {
    Authorization: `Bearer ${jwt}`,
    apikey: ANON_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function serviceHeaders() {
  return {
    Authorization: `Bearer ${SERVICE_KEY}`,
    apikey: SERVICE_KEY,
    'Content-Type': 'application/json',
  };
}

async function main() {
  const { jwt, userId } = await getJwt();

  const tenantRows = await req(`${SUPABASE_URL}/rest/v1/tenant_members?user_id=eq.${userId}&select=tenant_id&limit=1`, {
    headers: userHeaders(jwt),
  });
  const tenantId = tenantRows?.[0]?.tenant_id;
  if (!tenantId) throw new Error('No tenant id found');

  const createdCase = await req(`${SUPABASE_URL}/rest/v1/cases?select=*`, {
    method: 'POST',
    headers: userHeaders(jwt),
    body: [{ tenant_id: tenantId, name: CASE_NAME, status: 'active', created_by: userId }],
  });
  const caseId = createdCase?.[0]?.id;

  const createdFolder = await req(`${SUPABASE_URL}/rest/v1/folders?select=*`, {
    method: 'POST',
    headers: userHeaders(jwt),
    body: [{ tenant_id: tenantId, case_id: caseId, name: FOLDER_NAME, created_by: userId }],
  });
  const folderId = createdFolder?.[0]?.id;

  const createdFile = await req(`${SUPABASE_URL}/rest/v1/vault_assets?select=*`, {
    method: 'POST',
    headers: userHeaders(jwt),
    body: [{
      tenant_id: tenantId,
      case_id: caseId,
      folder_id: folderId,
      filename: FILE_NAME,
      filetype: 'text/plain',
      file_size: 1,
      storage_path: `${tenantId}/${caseId}/${folderId}/${FILE_NAME}`,
      uploaded_by: userId,
      status: 'uploaded',
      asset_type: 'document',
    }],
  });
  const fileId = createdFile?.[0]?.id;

  const deletedFiles = await req(`${SUPABASE_URL}/rest/v1/vault_assets?case_id=eq.${caseId}&tenant_id=eq.${tenantId}&select=id`, {
    method: 'DELETE',
    headers: userHeaders(jwt),
  });

  const deletedFolders = await req(`${SUPABASE_URL}/rest/v1/folders?case_id=eq.${caseId}&tenant_id=eq.${tenantId}&select=id`, {
    method: 'DELETE',
    headers: userHeaders(jwt),
  });

  const deletedCases = await req(`${SUPABASE_URL}/rest/v1/cases?id=eq.${caseId}&tenant_id=eq.${tenantId}&select=id`, {
    method: 'DELETE',
    headers: userHeaders(jwt),
  });

  const caseCheck = await req(`${SUPABASE_URL}/rest/v1/cases?id=eq.${caseId}&select=id,name`, {
    headers: serviceHeaders(),
  });
  const folderCheck = await req(`${SUPABASE_URL}/rest/v1/folders?case_id=eq.${caseId}&select=id,name`, {
    headers: serviceHeaders(),
  });
  const fileCheck = await req(`${SUPABASE_URL}/rest/v1/vault_assets?case_id=eq.${caseId}&select=id,filename`, {
    headers: serviceHeaders(),
  });

  const createdSession = await req(`${SUPABASE_URL}/rest/v1/chat_sessions?select=*`, {
    method: 'POST',
    headers: userHeaders(jwt),
    body: [{ tenant_id: tenantId, user_id: userId, title: CHAT_TITLE }],
  });
  const sessionId = createdSession?.[0]?.id;

  const createdMessage = await req(`${SUPABASE_URL}/rest/v1/chat_messages?select=id,session_id`, {
    method: 'POST',
    headers: userHeaders(jwt),
    body: [{ session_id: sessionId, role: 'user', content: 'delete test msg' }],
  });

  const deletedSessions = await req(`${SUPABASE_URL}/rest/v1/chat_sessions?id=eq.${sessionId}&tenant_id=eq.${tenantId}&user_id=eq.${userId}&select=id`, {
    method: 'DELETE',
    headers: userHeaders(jwt),
  });

  const sessionCheck = await req(`${SUPABASE_URL}/rest/v1/chat_sessions?id=eq.${sessionId}&select=id,title`, {
    headers: serviceHeaders(),
  });
  const messageCheck = await req(`${SUPABASE_URL}/rest/v1/chat_messages?session_id=eq.${sessionId}&select=id,session_id`, {
    headers: serviceHeaders(),
  });

  console.log(JSON.stringify({
    tenantId,
    matterTest: {
      created: { caseId, folderId, fileId },
      deletedCounts: {
        files: deletedFiles?.length || 0,
        folders: deletedFolders?.length || 0,
        cases: deletedCases?.length || 0,
      },
      remaining: {
        cases: caseCheck?.length || 0,
        folders: folderCheck?.length || 0,
        files: fileCheck?.length || 0,
      },
    },
    chatTest: {
      created: { sessionId, messageId: createdMessage?.[0]?.id },
      deletedCounts: { sessions: deletedSessions?.length || 0 },
      remaining: {
        sessions: sessionCheck?.length || 0,
        messages: messageCheck?.length || 0,
      },
    },
  }, null, 2));
}

main().catch((err) => {
  console.error('TEST_ERROR', err.message);
  process.exit(1);
});
