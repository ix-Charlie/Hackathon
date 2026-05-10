import { supabase } from './services/supabaseClient';

async function checkUserTenant() {
  try {
    // Get current user
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    
    if (userError || !user) {
      console.error('❌ No user logged in:', userError);
      return;
    }
    
    console.log('✅ User ID:', user.id);
    console.log('📧 Email:', user.email);
    
    // Check if user has a tenant
    const { data: tenantMember, error: memberError } = await supabase
      .from('tenant_members')
      .select('tenant_id, role')
      .eq('user_id', user.id)
      .maybeSingle();
    
    if (memberError) {
      console.error('❌ Error checking tenant:', memberError);
      return;
    }
    
    if (!tenantMember) {
      console.error('❌ NO TENANT FOUND! This is why RAG is not working.');
      console.log('💡 You need to create a tenant for this user.');
      return;
    }
    
    console.log('✅ Tenant ID:', tenantMember.tenant_id);
    console.log('✅ Role:', tenantMember.role);
    
    // Get tenant details
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select(`
        id,
        name,
        plan,
        pricing_tier_id,
        subscription_status,
        pricing_tiers (
          name,
          rate_limit_per_hour,
          max_documents
        )
      `)
      .eq('id', tenantMember.tenant_id)
      .single();
    
    if (tenantError) {
      console.error('❌ Error fetching tenant:', tenantError);
      return;
    }
    
    console.log('✅ Tenant Details:', tenant);
    
    // Check if user has any documents
    const { data: documents, error: docsError } = await supabase
      .from('documents')
      .select('id, filename, status')
      .eq('tenant_id', tenantMember.tenant_id)
      .limit(5);
    
    if (docsError) {
      console.error('❌ Error fetching documents:', docsError);
      return;
    }
    
    console.log('\n📄 Documents:', documents?.length || 0);
    if (documents && documents.length > 0) {
      documents.forEach(doc => {
        console.log(`  - ${doc.filename} (${doc.status})`);
      });
      
      // Check if chunks exist
      const { data: chunks, error: chunksError } = await supabase
        .from('document_chunks')
        .select('id')
        .eq('tenant_id', tenantMember.tenant_id)
        .limit(1);
      
      if (chunksError) {
        console.error('❌ Error checking chunks:', chunksError);
      } else {
        console.log('📝 Document chunks exist:', chunks && chunks.length > 0 ? 'YES' : 'NO');
      }
    } else {
      console.log('⚠️  No documents uploaded yet!');
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

checkUserTenant();
