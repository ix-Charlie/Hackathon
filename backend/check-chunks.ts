import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  // First get column names
  const { data: sample } = await supabase
    .from('document_chunks')
    .select('*')
    .limit(1);
  
  console.log('Chunk columns:', Object.keys(sample?.[0] || {}));
  
  // Then get chunks for the file
  const { data, error } = await supabase
    .from('document_chunks')
    .select('content')
    .eq('file_id', '11c17e0e-15d8-40ff-961d-3bdcb1c4abb1')
    .limit(2);
  
  if (error) {
    console.error('Error:', error);
    return;
  }
  
  console.log('\nSample text from PDF chunks:');
  data?.forEach((chunk, i) => {
    console.log(`\nChunk ${i + 1} (first 300 chars):`);
    console.log(chunk.content.substring(0, 300));
  });
}
check();
