/**
 * Diagnostic script to check and fix missing tenant_members entry
 * Run with: npx tsx fix-missing-tenant.ts
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkAndFixTenant() {
  console.log('🔍 Checking current user authentication...\n');
  
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  
  if (authError || !user) {
    console.error('❌ Not authenticated. Please log in first.');
    console.error('   Run the app, log in, then run this script again.');
    process.exit(1);
  }
  
  console.log(`✅ Authenticated as: ${user.email}`);
  console.log(`   User ID: ${user.id}\n`);
  
  // Check if user has tenant_members entry
  console.log('🔍 Checking tenant_members entry...\n');
  
  const { data: memberData, error: memberError } = await supabase
    .from('tenant_members')
    .select('tenant_id, role, joined_at')
    .eq('user_id', user.id)
    .single();
  
  if (memberData) {
    console.log('✅ tenant_members entry exists:');
    console.log(`   Tenant ID: ${memberData.tenant_id}`);
    console.log(`   Role: ${memberData.role}`);
    console.log(`   Joined: ${memberData.joined_at}`);
    console.log('\n✨ Everything looks good! Chat features should work.');
    process.exit(0);
  }
  
  if (memberError?.code !== 'PGRST116') { // PGRST116 = no rows found
    console.error('❌ Error checking tenant_members:', memberError);
    process.exit(1);
  }
  
  console.log('⚠️  No tenant_members entry found for this user.\n');
  console.log('This is why the New Chat button doesn\'t work.\n');
  console.log('To fix this, you need to manually create a tenant and link your user.');
  console.log('Please run this SQL in your Supabase SQL editor:\n');
  
  const email = user.email || 'your-organization';
  const orgName = email.split('@')[0] + ' Organization';
  
  console.log('----------------------------------------');
  console.log(`-- Fix missing tenant for user: ${user.email}`);
  console.log('-- Copy and run this in Supabase SQL Editor');
  console.log('----------------------------------------\n');
  console.log(`DO $$
DECLARE
  free_tier_id UUID;
  new_tenant_id UUID;
  target_user_id UUID := '${user.id}';
BEGIN
  -- Get free pricing tier
  SELECT id INTO free_tier_id FROM pricing_tiers WHERE name = 'Free' LIMIT 1;
  
  IF free_tier_id IS NULL THEN
    RAISE EXCEPTION 'No free pricing tier found. Please check pricing_tiers table.';
  END IF;

  -- Create tenant for this user
  INSERT INTO tenants (name, plan, pricing_tier_id, subscription_status)
  VALUES ('${orgName}', 'free', free_tier_id, 'active')
  RETURNING id INTO new_tenant_id;

  -- Ensure user record exists
  INSERT INTO users (id, email, created_at)
  VALUES (target_user_id, '${user.email}', NOW())
  ON CONFLICT (id) DO NOTHING;

  -- Link user to tenant
  INSERT INTO tenant_members (tenant_id, user_id, role, joined_at)
  VALUES (new_tenant_id, target_user_id, 'owner', NOW());

  RAISE NOTICE 'Successfully created tenant: % for user: %', new_tenant_id, target_user_id;
END $$;
`);
  console.log('----------------------------------------\n');
  console.log('After running the SQL, refresh your app and try the New Chat button again.');
}

checkAndFixTenant().catch(console.error);
