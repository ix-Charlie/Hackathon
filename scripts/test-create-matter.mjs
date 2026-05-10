const SUPABASE_URL = "https://ztjigmguhsihbtqhmwrx.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0amlnbWd1aHNpaGJ0cWhtd3J4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MTIwMzUsImV4cCI6MjA4MTM4ODAzNX0.DISNETtMFOWHzb8OAgomcZrFEKirEIPrUlAXx8psCWs";
const SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0amlnbWd1aHNpaGJ0cWhtd3J4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTgxMjAzNSwiZXhwIjoyMDgxMzg4MDM1fQ.WWt1iut3hxCRto0PqPVnya9_IENGNYm4NNipTghf0Ko";
const EMAIL = "hishamalix.amz@gmail.com";

async function getJwt() {
  const linkResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", email: EMAIL }),
  });
  const link = await linkResp.json();
  const otp = link?.email_otp;
  if (!otp) throw new Error(`No OTP: ${JSON.stringify(link)}`);

  const sessionResp = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token: otp, email: EMAIL }),
  });
  const session = await sessionResp.json();
  const jwt = session?.access_token;
  if (!jwt) throw new Error(`No JWT: ${JSON.stringify(session)}`);
  return jwt;
}

async function run() {
  const query = process.argv.slice(2).join(" ") || "Create a new matter called Acme v Beta for client Acme, case number 00107, description leave empty";
  const jwt = await getJwt();

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      apikey: ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: query,
      history: [],
      mode: "general",
      use_rag: true,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${t}`);
  }

  const decoder = new TextDecoder();
  const reader = resp.body.getReader();
  console.log("--- SSE Trace ---");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n").filter(Boolean);

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") {
        console.log("[DONE]");
        return;
      }
      try {
        const obj = JSON.parse(data);
        const t = obj.type;
        if (["state", "warning", "agent_task", "agent_plan", "tool_gateway", "tool_progress", "error", "verification"].includes(t)) {
          console.log(t, JSON.stringify(obj));
        } else if (t === "content") {
          const content = (obj.content || "").replace(/\s+/g, " ").trim();
          if (content) console.log("content", content.slice(0, 220));
        }
      } catch {
        // ignore
      }
    }
  }
}

run().catch((e) => {
  console.error("TEST_ERROR", e.message);
  process.exit(1);
});
