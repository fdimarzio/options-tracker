import { createClient } from "@supabase/supabase-js";

// Single shared client. The anon key is public by design; what it can reach is
// decided by Postgres RLS for the signed-in user's JWT, never by this key.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);
