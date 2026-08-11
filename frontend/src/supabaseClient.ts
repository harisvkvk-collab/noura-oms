// supabaseClient.ts — one shared client instance for the whole frontend.
// Uses the anon key, which is safe to expose (that's the whole point of
// RLS — see policies.sql) since every table requires auth.role() = 'authenticated'.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
