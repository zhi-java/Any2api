/**
 * Notion — dump loadUserContent 原始结构
 */

import fs from 'fs';

const probe = JSON.parse(fs.readFileSync('./probe.example.json', 'utf-8'));
const cookie = probe.cookies.map(c => `${c.name}=${c.value}`).join('; ');

const headers = {
  'cookie': cookie,
  'x-notion-active-user-header': probe.user_id,
  'x-notion-space-id': probe.space_id,
  'notion-client-version': probe.client_version,
  'notion-audit-log-platform': 'web',
  'accept': 'application/json',
  'content-type': 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'origin': 'https://www.notion.so',
  'referer': 'https://www.notion.so/ai',
  'user-agent': 'Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

// 1) loadUserContent — dump useful parts
const luc = await fetch('https://www.notion.so/api/v3/loadUserContent', { method:'POST', headers, body:'{}' });
const lucData = await luc.json();
console.log('=== loadUserContent ===\n');

// Dump notion_user
const nu = lucData.recordMap?.notion_user;
if (nu) {
  for (const [k, v] of Object.entries(nu)) {
    console.log(`notion_user[${k.slice(0,20)}]:`);
    console.log(JSON.stringify(v?.value || v, null, 2).slice(0, 600));
  }
}

// Dump space
const spaces = lucData.recordMap?.space;
if (spaces) {
  for (const [k, v] of Object.entries(spaces)) {
    console.log(`\nspace[${k.slice(0, 30)}]:`);
    console.log(JSON.stringify(v?.value || v, null, 2).slice(0, 800));
  }
}

// Dump space_view
const sv = lucData.recordMap?.space_view;
if (sv) {
  for (const [k, v] of Object.entries(sv)) {
    console.log(`\nspace_view[${k.slice(0, 30)}]:`);
    console.log(JSON.stringify(v?.value || v, null, 2).slice(0, 400));
  }
}

// Dump space_user
const su = lucData.recordMap?.space_user;
if (su) {
  for (const [k, v] of Object.entries(su)) {
    console.log(`\nspace_user[${k.slice(0, 30)}]:`);
    console.log(JSON.stringify(v?.value || v, null, 2).slice(0, 400));
  }
}

// Dump user_root
const ur = lucData.recordMap?.user_root;
if (ur) {
  for (const [k, v] of Object.entries(ur)) {
    console.log(`\nuser_root[${k.slice(0, 30)}]:`);
    console.log(JSON.stringify(v?.value || v, null, 2).slice(0, 400));
  }
}

// 2) getSpacesInitial — dump space data properly
console.log('\n\n=== getSpacesInitial ===');
const gsi = await fetch('https://www.notion.so/api/v3/getSpacesInitial', { method:'POST', headers, body:'{}' });
const gsiData = await gsi.json();
const userData = gsiData?.users?.[probe.user_id];
if (userData) {
  console.log(`\nusers.${probe.user_id}.space:`);
  for (const [k, v] of Object.entries(userData.space || {})) {
    console.log(`\n  [${k.slice(0, 30)}]:`);
    console.log(`  value:`, JSON.stringify(v?.value || v, null, 4).slice(0, 1500));
  }
  console.log(`\nusers.${probe.user_id}.space_view:`);
  for (const [k, v] of Object.entries(userData.space_view || {})) {
    console.log(`\n  [${k.slice(0, 30)}]:`);
    console.log(`  value:`, JSON.stringify(v?.value || v, null, 4).slice(0, 800));
  }
}