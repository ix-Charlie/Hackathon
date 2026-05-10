#!/bin/bash
# =============================================================================
# Horizon Chat Performance Test
# Tests the deployed chat edge function with timing measurements
# =============================================================================

SUPABASE_URL="https://ztjigmguhsihbtqhmwrx.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0amlnbWd1aHNpaGJ0cWhtd3J4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MTIwMzUsImV4cCI6MjA4MTM4ODAzNX0.DISNETtMFOWHzb8OAgomcZrFEKirEIPrUlAXx8psCWs"
SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0amlnbWd1aHNpaGJ0cWhtd3J4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTgxMjAzNSwiZXhwIjoyMDgxMzg4MDM1fQ.WWt1iut3hxCRto0PqPVnya9_IENGNYm4NNipTghf0Ko"
CASE_ID="20545e56-5f63-4a24-b3c3-5f74bc5d77d0"

echo "=============================================="
echo "  Horizon Chat Performance Test"
echo "=============================================="

# Step 1: Generate a fresh JWT via magic link admin API
echo ""
echo "[1/3] Generating user session..."
LINK_RESP=$(curl -s "${SUPABASE_URL}/auth/v1/admin/generate_link" \
  -X POST \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"type":"magiclink","email":"hishamalix.amz@gmail.com"}')

OTP=$(echo "$LINK_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['email_otp'])" 2>/dev/null)

if [ -z "$OTP" ]; then
  echo "ERROR: Failed to generate magic link"
  echo "$LINK_RESP"
  exit 1
fi

# Step 2: Verify OTP to get JWT
echo "[2/3] Exchanging OTP for JWT..."
SESSION_RESP=$(curl -s "${SUPABASE_URL}/auth/v1/verify" \
  -X POST \
  -H "apikey: ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"token\":\"${OTP}\",\"email\":\"hishamalix.amz@gmail.com\"}")

JWT=$(echo "$SESSION_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)

if [ -z "$JWT" ]; then
  echo "ERROR: Failed to verify OTP"
  echo "$SESSION_RESP"
  exit 1
fi

echo "       JWT obtained (expires in 1 hour)"

# Step 3: Test chat query
echo "[3/3] Sending chat query..."
echo ""

QUERY="${1:-who is lyndsy}"
echo "Query: \"$QUERY\""
echo "Case:  $CASE_ID"
echo "----------------------------------------------"
echo ""

START_TIME=$(python3 -c "import time; print(time.time())")

# Stream the response with timestamps
curl -sN "${SUPABASE_URL}/functions/v1/chat" \
  -H "Authorization: Bearer ${JWT}" \
  -H "apikey: ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"${QUERY}\",
    \"history\": [],
    \"case_id\": \"${CASE_ID}\",
    \"use_rag\": true
  }" 2>/dev/null | while IFS= read -r line; do
  
  ELAPSED=$(python3 -c "import time; print(f'{time.time() - ${START_TIME}:.1f}s')")
  
  # Skip empty lines
  [ -z "$line" ] && continue
  
  # Skip SSE comments (heartbeats)
  [[ "$line" == :* ]] && continue
  
  # Remove "data: " prefix
  if [[ "$line" == data:* ]]; then
    DATA="${line#data: }"
    
    # Check for [DONE]
    if [ "$DATA" = "[DONE]" ]; then
      echo ""
      echo "----------------------------------------------"
      echo "[${ELAPSED}] STREAM COMPLETE"
      break
    fi
    
    # Parse the SSE event
    TYPE=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('type',''))" 2>/dev/null)
    
    case "$TYPE" in
      state)
        VALUE=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('value',''))" 2>/dev/null)
        SUBST=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('substantive',''))" 2>/dev/null)
        echo "[${ELAPSED}] STATE: ${VALUE} (substantive=${SUBST})"
        ;;
      content)
        VALUE=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('value',''); print(v[:80]+'...' if len(v)>80 else v)" 2>/dev/null)
        echo "[${ELAPSED}] CONTENT: ${VALUE}"
        ;;
      reasoning)
        VALUE=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('value',''); print(v[:80]+'...' if len(v)>80 else v)" 2>/dev/null)
        echo "[${ELAPSED}] REASONING: ${VALUE}"
        ;;
      error)
        VALUE=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('value',''))" 2>/dev/null)
        echo "[${ELAPSED}] ERROR: ${VALUE}"
        ;;
      *)
        echo "[${ELAPSED}] RAW: ${DATA:0:100}"
        ;;
    esac
  fi
done

END_TIME=$(python3 -c "import time; print(time.time())")
TOTAL=$(python3 -c "print(f'{${END_TIME} - ${START_TIME}:.1f}s')")
echo ""
echo "=============================================="
echo "  TOTAL TIME: ${TOTAL}"
echo "=============================================="
