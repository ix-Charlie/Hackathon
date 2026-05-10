/**
 * Debug script to check chat messages in the database
 * Run with: npx tsx debug-chat-messages.ts
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || 'YOUR_SUPABASE_URL';
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || 'YOUR_SUPABASE_KEY';

const supabase = createClient(supabaseUrl, supabaseKey);

async function debugChatMessages() {
  console.log('🔍 Checking chat_messages table...\n');

  // Get all sessions
  const { data: sessions, error: sessionsError } = await supabase
    .from('chat_sessions')
    .select('id, title, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  if (sessionsError) {
    console.error('❌ Error fetching sessions:', sessionsError);
    return;
  }

  console.log(`📋 Found ${sessions?.length || 0} recent sessions\n`);

  for (const session of sessions || []) {
    console.log(`\n📁 Session: ${session.title} (${session.id})`);
    console.log(`   Created: ${session.created_at}`);

    // Get messages for this session
    const { data: messages, error: messagesError } = await supabase
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('session_id', session.id)
      .order('created_at', { ascending: true });

    if (messagesError) {
      console.error('   ❌ Error fetching messages:', messagesError);
      continue;
    }

    console.log(`   💬 Messages: ${messages?.length || 0}`);
    
    if (messages && messages.length > 0) {
      // Count by role
      const roleCounts = messages.reduce((acc, m) => {
        acc[m.role] = (acc[m.role] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log('   Role breakdown:', roleCounts);

      // Show first few messages
      console.log('\n   Sample messages:');
      messages.slice(0, 5).forEach((msg, idx) => {
        const preview = msg.content.substring(0, 60).replace(/\n/g, ' ');
        console.log(`   ${idx + 1}. [${msg.role}] ${preview}${msg.content.length > 60 ? '...' : ''}`);
      });
    } else {
      console.log('   ⚠️  No messages found in this session');
    }
  }

  console.log('\n\n✅ Debug complete');
  console.log('\nExpected roles: "user" and "model"');
  console.log('If you see other role names, the conversion function needs updating.');
}

debugChatMessages().catch(console.error);
