const PAM_URL = process.env.PAM_SUPABASE_URL;
const PAM_KEY = process.env.PAM_SUPABASE_KEY;
const PRI_URL = process.env.PRI_SUPABASE_URL;
const PRI_KEY = process.env.PRI_SUPABASE_KEY;

const TOD_PROJECT_ID = 'ad7ebc28-87cd-4a31-87e9-6389e4f7626a';

async function pamGet(table, params = '') {
  const res = await fetch(`${PAM_URL}/rest/v1/${table}?${params}`, {
    headers: {
      apikey: PAM_KEY,
      Authorization: `Bearer ${PAM_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`PAM fetch ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function priUpsert(table, rows) {
  if (!rows.length) { console.log(`  No rows for ${table}`); return; }
  const res = await fetch(`${PRI_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: PRI_KEY,
      Authorization: `Bearer ${PRI_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`PRI upsert ${table} failed: ${res.status} ${await res.text()}`);
  console.log(`  Upserted ${rows.length} rows into ${table}`);
}

async function main() {
  console.log('Starting PAM sync...');

  // 1. Sync project
  console.log('Syncing project...');
  const projects = await pamGet(
    'projects',
    `id=eq.${TOD_PROJECT_ID}&select=id,name,description,color,status,start_date,due_date,created_at,updated_at`
  );
  await priUpsert('pam_projects', projects.map(p => ({ ...p, synced_at: new Date().toISOString() })));

  // 2. Sync milestones
  console.log('Syncing milestones...');
  const milestones = await pamGet(
    'milestones',
    `project_id=eq.${TOD_PROJECT_ID}&select=id,project_id,name,description,due_date,status,created_at`
  );
  await priUpsert('pam_milestones', milestones.map(m => ({ ...m, synced_at: new Date().toISOString() })));

  // 3. Sync tasks
  console.log('Syncing tasks...');
  const tasks = await pamGet(
    'tasks',
    `project_id=eq.${TOD_PROJECT_ID}&select=id,project_id,milestone_id,parent_task_id,assignee,title,notes,status,priority,start_date,due_date,completed_date,points,bonus_category,recurring,created_by_source,created_by_user_id,sort_order,bonus_category_name,created_at,updated_at`
  );
  await priUpsert('pam_tasks', tasks.map(({ created_by_source, created_by_user_id, ...t }) => ({
    ...t,
    // PRI pam_tasks still has created_by (nullable) — map from source fields best-effort
    created_by: created_by_user_id ?? created_by_source ?? null,
    synced_at: new Date().toISOString(),
  })));

  console.log('PAM sync complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
