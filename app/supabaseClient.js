import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://hsaafxgfalhdgbtzcjqs.supabase.co";
const supabaseKey = "sb_publishable_SlgK6LvRFb8QSg38X4nx3w_TJq21mLN";

export const supabase = createClient(supabaseUrl, supabaseKey);