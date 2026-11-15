import { createClient } from "@supabase/supabase-js";

function respond(res, status, body) {
  res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return respond(res, 405, { error: "Method not allowed." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return respond(res, 500, { error: "Invitation service is not configured." });
  }

  const authorization = req.headers.authorization || "";
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return respond(res, 401, { error: "Sign in as an administrator to continue." });

  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const role = req.body?.role;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["staff", "reviewer", "admin"].includes(role)) {
    return respond(res, 400, { error: "Enter a valid email address and a permitted staff role." });
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: authError } = await authClient.auth.getUser(accessToken);
  if (authError || !userData.user) return respond(res, 401, { error: "Your session is invalid or expired." });

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: caller, error: callerError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (callerError) {
    console.error("Unable to verify invitation administrator.", callerError.message);
    return respond(res, 500, { error: "Could not verify administrator permissions." });
  }
  if (caller?.role !== "admin") return respond(res, 403, { error: "Administrator access is required." });

  const { data: invitation, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email);
  if (inviteError) return respond(res, 400, { error: inviteError.message });

  const { error: roleError } = await adminClient
    .from("profiles")
    .update({ role })
    .eq("id", invitation.user.id);
  if (roleError) {
    console.error("Invitation was sent but assigning its role failed.", roleError.message);
    return respond(res, 500, { error: "The invitation was sent, but the role could not be assigned. Recheck the user’s role in Supabase." });
  }

  return respond(res, 200, { email, role });
}
