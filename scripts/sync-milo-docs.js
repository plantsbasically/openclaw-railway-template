// scripts/sync-milo-docs.js
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import FormData from 'form-data';

const DOCS_DIR = '/data/workspace/agents/milo';
const COLLECTION_NAME = 'Milo Knowledge Base';

const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_MANAGEMENT_API_KEY = process.env.XAI_MANAGEMENT_API_KEY;

if (!XAI_API_KEY || !XAI_MANAGEMENT_API_KEY) {
  console.error('❌ Missing XAI_API_KEY or XAI_MANAGEMENT_API_KEY');
  process.exit(1);
}

async function main() {
  console.log('🔄 Starting Milo docs sync...');

  let collectionId = await getOrCreateCollection();
  console.log(`✅ Using collection: ${COLLECTION_NAME} (${collectionId})`);

  const mdFiles = fs.readdirSync(DOCS_DIR)
    .filter(file => file.toLowerCase().endsWith('.md'))
    .map(file => ({
      name: file,
      path: path.join(DOCS_DIR, file)
    }));

  console.log(`📁 Found ${mdFiles.length} markdown files`);

  for (const file of mdFiles) {
    console.log(`Uploading ${file.name}...`);
    const fileId = await uploadFile(file);
    await addFileToCollection(collectionId, fileId);
    console.log(`✅ ${file.name} → added`);
  }

  console.log('\n🎉 Milo Knowledge Base sync complete!');
  console.log(`Collection ID (copy this for your voice session): ${collectionId}`);
}

async function getOrCreateCollection() {
  const listRes = await fetch('https://management-api.x.ai/v1/collections', {
    headers: { Authorization: `Bearer ${XAI_MANAGEMENT_API_KEY}` }
  });
  const { collections } = await listRes.json();

  const existing = collections?.find(c => c.collection_name === COLLECTION_NAME);
  if (existing) return existing.collection_id;

  const createRes = await fetch('https://management-api.x.ai/v1/collections', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${XAI_MANAGEMENT_API_KEY}`
    },
    body: JSON.stringify({ collection_name: COLLECTION_NAME })
  });

  const data = await createRes.json();
  return data.collection_id;
}

async function uploadFile(file) {
  const form = new FormData();
  form.append('file', fs.createReadStream(file.path), {
    filename: file.name,
    contentType: 'text/markdown'
  });
  form.append('purpose', 'assistants');

  const res = await fetch('https://api.x.ai/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    body: form
  });

  const data = await res.json();
  return data.id;
}

async function addFileToCollection(collectionId, fileId) {
  await fetch(`https://management-api.x.ai/v1/collections/${collectionId}/documents/${fileId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${XAI_MANAGEMENT_API_KEY}` }
  });
}

main().catch(console.error);
