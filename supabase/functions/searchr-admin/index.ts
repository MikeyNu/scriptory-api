import { createClient } from "supabase";
import {
  AnyRecord,
  clean,
  configuredSources,
  int,
  loadSourceConfig,
  normalizeMany
} from "../_shared/domain.ts";

const functionName = "searchr-admin";
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const bootstrapToken = Deno.env.get("ADMIN_BOOTSTRAP_TOKEN") || Deno.env.get("ADMIN_TOKEN") || "";

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const ROLES = ["owner", "platform_admin", "operations_admin", "support_admin", "content_admin", "analyst"];
const SOURCE_TYPES = ["adzuna_query_set", "greenhouse_board", "lever_board", "partner_feed"];
const VISIBILITY_STATES = ["visible", "hidden", "featured", "archived"];
const REVIEW_STATES = ["approved", "needs_review", "rejected"];
const MEMBERSHIP_STATUS = ["active", "suspended"];
const PROFILE_STATUS = ["active", "suspended"];
const CAMPAIGN_STATUS = ["draft", "scheduled", "sent", "cancelled"];

const CAPABILITY_ROLES: Record<string, string[]> = {
  dashboard_read: ROLES,
  users_read: ["owner", "platform_admin", "support_admin", "analyst"],
  users_write: ["owner", "platform_admin", "support_admin"],
  jobs_read: ["owner", "platform_admin", "operations_admin", "analyst"],
  jobs_write: ["owner", "platform_admin", "operations_admin"],
  sources_read: ["owner", "platform_admin", "operations_admin", "analyst"],
  sources_write: ["owner", "platform_admin", "operations_admin"],
  templates_read: ["owner", "platform_admin", "content_admin", "analyst"],
  templates_write: ["owner", "platform_admin", "content_admin"],
  content_read: ["owner", "platform_admin", "content_admin", "analyst"],
  content_write: ["owner", "platform_admin", "content_admin"],
  notifications_read: ["owner", "platform_admin", "operations_admin", "support_admin", "analyst"],
  notifications_write: ["owner", "platform_admin", "operations_admin"],
  settings_read: ["owner", "platform_admin", "content_admin", "analyst"],
  settings_write: ["owner", "platform_admin", "content_admin"],
  audit_read: ["owner", "platform_admin", "analyst"],
  admin_read: ["owner", "platform_admin", "analyst"],
  admin_write: ["owner"]
};

type AdminContext = {
  requestId: string;
  token: string;
  user: AnyRecord;
  profile: AnyRecord | null;
  membership: AnyRecord | null;
  bootstrapRequired: boolean;
};

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const url = new URL(req.url);
    const path = routePath(url.pathname);
    return await route(req, path, url.searchParams, headers);
  } catch (error) {
    const status = Number(error?.statusCode || error?.status || 500);
    if (status >= 500) console.error(error);
    return json({ error: status >= 500 ? "Internal server error" : clean(error?.message) || "Request failed." }, status, headers);
  }
});

async function route(req: Request, path: string, params: URLSearchParams, headers: HeadersInit): Promise<Response> {
  if (path === "/health" && req.method === "GET") {
    return json({ ok: true, service: "searchr-admin", runtime: "supabase-edge", time: new Date().toISOString() }, 200, headers);
  }

  const ctx = await loadAdminContext(req);

  if (path === "/v1/admin/me" && req.method === "GET") {
    if (isAuthorizedAdmin(ctx)) await touchMembership(ctx);
    return json({
      authorized: isAuthorizedAdmin(ctx),
      bootstrapRequired: ctx.bootstrapRequired,
      membership: ctx.membership,
      profile: ctx.profile,
      capabilities: listCapabilities(ctx.membership?.role),
      roles: ROLES
    }, 200, headers);
  }

  if (path === "/v1/admin/bootstrap" && req.method === "POST") {
    const body = await readJson(req);
    const result = await bootstrapOwner(ctx, body);
    return json(result, 201, headers);
  }

  if (path === "/v1/admin/dashboard" && req.method === "GET") {
    assertCapability(ctx, "dashboard_read");
    return json(await loadDashboard(), 200, headers);
  }

  if (path === "/v1/admin/activity" && req.method === "GET") {
    assertCapability(ctx, "dashboard_read");
    return json(await loadActivity(params), 200, headers);
  }

  if (path === "/v1/admin/users" && req.method === "GET") {
    assertCapability(ctx, "users_read");
    return json(await listUsers(params), 200, headers);
  }

  const userMatch = path.match(/^\/v1\/admin\/users\/([^/]+)$/);
  if (userMatch && req.method === "GET") {
    assertCapability(ctx, "users_read");
    return json(await getUserDetail(decodeURIComponent(userMatch[1])), 200, headers);
  }

  const userStatusMatch = path.match(/^\/v1\/admin\/users\/([^/]+)\/status$/);
  if (userStatusMatch && req.method === "PATCH") {
    assertCapability(ctx, "users_write");
    const userId = decodeURIComponent(userStatusMatch[1]);
    const body = await readJson(req);
    return json(await updateUserStatus(ctx, userId, body), 200, headers);
  }

  const userNotesMatch = path.match(/^\/v1\/admin\/users\/([^/]+)\/notes$/);
  if (userNotesMatch && req.method === "POST") {
    assertCapability(ctx, "users_write");
    const userId = decodeURIComponent(userNotesMatch[1]);
    const body = await readJson(req);
    return json(await addUserNote(ctx, userId, body), 201, headers);
  }
  if (userNotesMatch && req.method === "GET") {
    assertCapability(ctx, "users_read");
    return json(await listUserNotes(decodeURIComponent(userNotesMatch[1])), 200, headers);
  }

  const userResourceMatch = path.match(/^\/v1\/admin\/users\/([^/]+)\/(cv-documents|saved-jobs|applications|notifications)$/);
  if (userResourceMatch && req.method === "GET") {
    assertCapability(ctx, "users_read");
    const userId = decodeURIComponent(userResourceMatch[1]);
    const resource = userResourceMatch[2];
    if (resource === "cv-documents") return json(await listUserCvDocuments(userId), 200, headers);
    if (resource === "saved-jobs") return json(await listUserSavedJobs(userId), 200, headers);
    if (resource === "applications") return json(await listUserApplications(userId), 200, headers);
    if (resource === "notifications") return json(await listUserNotifications(userId), 200, headers);
  }

  if (path === "/v1/admin/jobs" && req.method === "GET") {
    assertCapability(ctx, "jobs_read");
    return json(await listJobs(params), 200, headers);
  }

  const jobDetailMatch = path.match(/^\/v1\/admin\/jobs\/([^/]+)$/);
  if (jobDetailMatch && req.method === "GET") {
    assertCapability(ctx, "jobs_read");
    return json(await getJobDetail(decodeURIComponent(jobDetailMatch[1])), 200, headers);
  }

  const jobRawMatch = path.match(/^\/v1\/admin\/jobs\/([^/]+)\/raw-payload$/);
  if (jobRawMatch && req.method === "GET") {
    assertCapability(ctx, "jobs_read");
    return json(await getJobRawPayload(decodeURIComponent(jobRawMatch[1])), 200, headers);
  }

  const jobModerationMatch = path.match(/^\/v1\/admin\/jobs\/([^/]+)\/moderation$/);
  if (jobModerationMatch && req.method === "PATCH") {
    assertCapability(ctx, "jobs_write");
    const body = await readJson(req);
    return json(await updateJobModeration(ctx, decodeURIComponent(jobModerationMatch[1]), body), 200, headers);
  }

  if (path === "/v1/admin/jobs/bulk" && req.method === "POST") {
    assertCapability(ctx, "jobs_write");
    const body = await readJson(req);
    return json(await bulkModerateJobs(ctx, body), 200, headers);
  }

  if (path === "/v1/admin/sources" && req.method === "GET") {
    assertCapability(ctx, "sources_read");
    return json(await listSources(), 200, headers);
  }

  if (path === "/v1/admin/sources" && req.method === "POST") {
    assertCapability(ctx, "sources_write");
    const body = await readJson(req);
    return json(await createSource(ctx, body), 201, headers);
  }

  const sourceMatch = path.match(/^\/v1\/admin\/sources\/([^/]+)$/);
  if (sourceMatch && req.method === "PATCH") {
    assertCapability(ctx, "sources_write");
    const body = await readJson(req);
    return json(await updateSource(ctx, decodeURIComponent(sourceMatch[1]), body), 200, headers);
  }

  const sourceActionMatch = path.match(/^\/v1\/admin\/sources\/([^/]+)\/(test|run)$/);
  if (sourceActionMatch && req.method === "POST") {
    assertCapability(ctx, "sources_write");
    const sourceId = decodeURIComponent(sourceActionMatch[1]);
    const action = sourceActionMatch[2];
    if (action === "test") return json(await testSource(ctx, sourceId), 200, headers);
    return json(await runSources(ctx, [sourceId]), 200, headers);
  }

  if (path === "/v1/admin/ingestion/runs" && req.method === "GET") {
    assertCapability(ctx, "sources_read");
    return json(await listIngestionRuns(params), 200, headers);
  }

  const runMatch = path.match(/^\/v1\/admin\/ingestion\/runs\/([^/]+)$/);
  if (runMatch && req.method === "GET") {
    assertCapability(ctx, "sources_read");
    return json(await getIngestionRun(decodeURIComponent(runMatch[1])), 200, headers);
  }

  const runSourcesMatch = path.match(/^\/v1\/admin\/ingestion\/runs\/([^/]+)\/sources$/);
  if (runSourcesMatch && req.method === "GET") {
    assertCapability(ctx, "sources_read");
    return json(await listIngestionRunSources(decodeURIComponent(runSourcesMatch[1])), 200, headers);
  }

  if (path === "/v1/admin/ingestion/run" && req.method === "POST") {
    assertCapability(ctx, "sources_write");
    const body = await readJson(req);
    return json(await runSources(ctx, listOf(body.sourceIds)), 200, headers);
  }

  if (path === "/v1/admin/templates" && req.method === "GET") {
    assertCapability(ctx, "templates_read");
    return json(await listTemplates(), 200, headers);
  }

  const templateMatch = path.match(/^\/v1\/admin\/templates\/([^/]+)$/);
  if (templateMatch && req.method === "PATCH") {
    assertCapability(ctx, "templates_write");
    const body = await readJson(req);
    return json(await updateTemplate(ctx, decodeURIComponent(templateMatch[1]), body), 200, headers);
  }

  if (path === "/v1/admin/palettes" && req.method === "GET") {
    assertCapability(ctx, "templates_read");
    return json(await listPalettes(), 200, headers);
  }

  const paletteMatch = path.match(/^\/v1\/admin\/palettes\/([^/]+)$/);
  if (paletteMatch && req.method === "PATCH") {
    assertCapability(ctx, "templates_write");
    const body = await readJson(req);
    return json(await updatePalette(ctx, decodeURIComponent(paletteMatch[1]), body), 200, headers);
  }

  if (path === "/v1/admin/content" && req.method === "GET") {
    assertCapability(ctx, "content_read");
    return json(await listContent(params), 200, headers);
  }

  const contentMatch = path.match(/^\/v1\/admin\/content\/([^/]+)$/);
  if (contentMatch && req.method === "GET") {
    assertCapability(ctx, "content_read");
    return json(await getContentBlock(decodeURIComponent(contentMatch[1])), 200, headers);
  }
  if (contentMatch && req.method === "PATCH") {
    assertCapability(ctx, "content_write");
    const body = await readJson(req);
    return json(await updateContentBlock(ctx, decodeURIComponent(contentMatch[1]), body), 200, headers);
  }

  if (path === "/v1/admin/settings" && req.method === "GET") {
    assertCapability(ctx, "settings_read");
    return json(await listSettings(), 200, headers);
  }

  const settingMatch = path.match(/^\/v1\/admin\/settings\/([^/]+)$/);
  if (settingMatch && req.method === "PATCH") {
    assertCapability(ctx, "settings_write");
    const body = await readJson(req);
    return json(await updateSetting(ctx, decodeURIComponent(settingMatch[1]), body), 200, headers);
  }

  if (path === "/v1/admin/feature-flags" && req.method === "GET") {
    assertCapability(ctx, "settings_read");
    return json(await listFeatureFlags(), 200, headers);
  }

  const flagMatch = path.match(/^\/v1\/admin\/feature-flags\/([^/]+)$/);
  if (flagMatch && req.method === "PATCH") {
    assertCapability(ctx, "settings_write");
    const body = await readJson(req);
    return json(await updateFeatureFlag(ctx, decodeURIComponent(flagMatch[1]), body), 200, headers);
  }

  if (path === "/v1/admin/notifications/deliveries" && req.method === "GET") {
    assertCapability(ctx, "notifications_read");
    return json(await listNotificationDeliveries(params), 200, headers);
  }

  if (path === "/v1/admin/notifications/failures" && req.method === "GET") {
    assertCapability(ctx, "notifications_read");
    return json(await listNotificationFailures(params), 200, headers);
  }

  if (path === "/v1/admin/notification-campaigns" && req.method === "GET") {
    assertCapability(ctx, "notifications_read");
    return json(await listCampaigns(), 200, headers);
  }

  if (path === "/v1/admin/notification-campaigns" && req.method === "POST") {
    assertCapability(ctx, "notifications_write");
    const body = await readJson(req);
    return json(await createCampaign(ctx, body), 201, headers);
  }

  const campaignMatch = path.match(/^\/v1\/admin\/notification-campaigns\/([^/]+)$/);
  if (campaignMatch && req.method === "PATCH") {
    assertCapability(ctx, "notifications_write");
    const body = await readJson(req);
    return json(await updateCampaign(ctx, decodeURIComponent(campaignMatch[1]), body), 200, headers);
  }

  const campaignSendMatch = path.match(/^\/v1\/admin\/notification-campaigns\/([^/]+)\/send$/);
  if (campaignSendMatch && req.method === "POST") {
    assertCapability(ctx, "notifications_write");
    return json(await sendCampaign(ctx, decodeURIComponent(campaignSendMatch[1])), 200, headers);
  }

  if (path === "/v1/admin/audit-logs" && req.method === "GET") {
    assertCapability(ctx, "audit_read");
    return json(await listAuditLogs(params), 200, headers);
  }

  if (path === "/v1/admin/admin-memberships" && req.method === "GET") {
    assertCapability(ctx, "admin_read");
    return json(await listAdminMemberships(), 200, headers);
  }

  if (path === "/v1/admin/admin-memberships" && req.method === "POST") {
    assertCapability(ctx, "admin_write");
    const body = await readJson(req);
    return json(await createAdminMembership(ctx, body), 201, headers);
  }

  const membershipMatch = path.match(/^\/v1\/admin\/admin-memberships\/([^/]+)$/);
  if (membershipMatch && req.method === "PATCH") {
    assertCapability(ctx, "admin_write");
    const body = await readJson(req);
    return json(await updateAdminMembership(ctx, decodeURIComponent(membershipMatch[1]), body), 200, headers);
  }

  return json({ error: "Not found" }, 404, headers);
}

async function loadAdminContext(req: Request): Promise<AdminContext> {
  const token = bearerToken(req);
  if (!token) throw problem(401, "Admin session required.");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw problem(401, "Admin session required.");
  const user = data.user;
  const requestId = clean(req.headers.get("x-vercel-id") || req.headers.get("x-request-id")) || crypto.randomUUID();
  const [{ data: profile, error: profileError }, { data: membership, error: membershipError }, { count, error: countError }] = await Promise.all([
    db.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    db.from("admin_memberships").select("*").eq("user_id", user.id).maybeSingle(),
    db.from("admin_memberships").select("user_id", { count: "exact", head: true })
  ]);
  if (profileError) throw profileError;
  if (membershipError) throw membershipError;
  if (countError) throw countError;
  return {
    requestId,
    token,
    user,
    profile: profile || null,
    membership: membership || null,
    bootstrapRequired: Number(count || 0) === 0
  };
}

function isAuthorizedAdmin(ctx: AdminContext): boolean {
  return Boolean(
    ctx.membership
    && ctx.membership.status === "active"
    && ctx.profile?.account_status !== "suspended"
  );
}

function assertCapability(ctx: AdminContext, capability: string): void {
  if (ctx.profile?.account_status === "suspended") throw problem(403, "Account access is suspended.");
  if (!isAuthorizedAdmin(ctx)) {
    if (ctx.bootstrapRequired) throw problem(403, "Admin bootstrap is required.");
    throw problem(403, "Admin access is not permitted.");
  }
  const allowed = CAPABILITY_ROLES[capability] || [];
  if (!allowed.includes(ctx.membership?.role)) {
    throw problem(403, "This admin role cannot perform that action.");
  }
}

function listCapabilities(role: string): string[] {
  return Object.entries(CAPABILITY_ROLES)
    .filter(([, roles]) => roles.includes(role))
    .map(([capability]) => capability);
}

async function touchMembership(ctx: AdminContext): Promise<void> {
  if (!ctx.membership?.user_id) return;
  const { error } = await db
    .from("admin_memberships")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("user_id", ctx.membership.user_id);
  if (error) console.error(error);
}

async function bootstrapOwner(ctx: AdminContext, body: AnyRecord): Promise<AnyRecord> {
  if (!ctx.bootstrapRequired) throw problem(409, "Admin owner already exists.");
  if (!bootstrapToken) throw problem(500, "Bootstrap token is not configured.");
  if (clean(body.bootstrapToken) !== bootstrapToken) throw problem(401, "Bootstrap token is invalid.");
  const row = {
    user_id: ctx.user.id,
    role: "owner",
    status: "active",
    assigned_by: ctx.user.id,
    assigned_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  };
  const { data, error } = await db.from("admin_memberships").insert(row).select("*").single();
  if (error) throw error;
  await audit(ctx, "bootstrap_owner", "admin_membership", ctx.user.id, {}, data, {});
  return { membership: data };
}

async function loadDashboard(): Promise<AnyRecord> {
  const [{ data: summary, error: summaryError }, { data: runs, error: runsError }, { data: sources, error: sourcesError }, { data: failures, error: failuresError }, { data: activity, error: activityError }, { data: audit, error: auditError }] = await Promise.all([
    db.from("admin_dashboard_summary_v").select("*").maybeSingle(),
    db.from("ingestion_runs").select("*").order("started_at", { ascending: false }).limit(8),
    db.from("admin_source_health_v").select("*").order("last_run_started_at", { ascending: false, nullsFirst: false }).limit(8),
    db.from("admin_notification_failures_v").select("*").order("created_at", { ascending: false }).limit(8),
    db.from("admin_user_activity_v").select("*").order("created_at", { ascending: false }).limit(8),
    db.from("admin_audit_logs").select("*").order("created_at", { ascending: false }).limit(10)
  ]);
  if (summaryError) throw summaryError;
  if (runsError) throw runsError;
  if (sourcesError) throw sourcesError;
  if (failuresError) throw failuresError;
  if (activityError) throw activityError;
  if (auditError) throw auditError;
  return {
    summary: summary || {},
    ingestionRuns: runs || [],
    sourceHealth: sources || [],
    notificationFailures: failures || [],
    recentUsers: activity || [],
    recentAudit: audit || []
  };
}

async function loadActivity(params: URLSearchParams): Promise<AnyRecord> {
  const pagination = pageParams(params, 20, 100);
  const query = db
    .from("admin_audit_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(pagination.from, pagination.to);
  const { data, count, error } = await query;
  if (error) throw error;
  return { page: pagination.page, limit: pagination.limit, total: count || 0, items: data || [] };
}

async function listUsers(params: URLSearchParams): Promise<AnyRecord> {
  const pagination = pageParams(params, 24, 200);
  let query = db
    .from("admin_user_activity_v")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });
  const search = searchTerm(params.get("query"));
  const status = clean(params.get("status"));
  if (search) query = query.or(`email.ilike.%${search}%,display_name.ilike.%${search}%`);
  if (PROFILE_STATUS.includes(status)) query = query.eq("account_status", status);
  const { data, count, error } = await query.range(pagination.from, pagination.to);
  if (error) throw error;
  return { page: pagination.page, limit: pagination.limit, total: count || 0, users: data || [] };
}

async function getUserDetail(userId: string): Promise<AnyRecord> {
  const [profile, settings, preferences, cvDocuments, savedJobs, applications, notifications, accountEvents, notes] = await Promise.all([
    getSingle("profiles", "id", userId),
    getSingle("user_settings", "user_id", userId),
    getSingle("notification_preferences", "user_id", userId),
    listUserCvDocuments(userId).then((result) => result.cvDocuments),
    listUserSavedJobs(userId).then((result) => result.savedJobs),
    listUserApplications(userId).then((result) => result.applications),
    listUserNotifications(userId).then((result) => result.notifications),
    listUserAccountEvents(userId),
    listUserNotes(userId).then((result) => result.notes)
  ]);
  return {
    profile,
    settings,
    preferences,
    cvDocuments,
    savedJobs,
    applications,
    notifications,
    accountEvents,
    notes,
    stats: {
      cvDocuments: cvDocuments.length,
      savedJobs: savedJobs.length,
      applications: applications.length,
      notifications: notifications.length,
      unreadNotifications: notifications.filter((item: AnyRecord) => !item.read_at).length
    }
  };
}

async function updateUserStatus(ctx: AdminContext, userId: string, body: AnyRecord): Promise<AnyRecord> {
  const status = clean(body.status);
  if (!PROFILE_STATUS.includes(status)) throw problem(400, "Invalid account status.");
  const before = await getSingle("profiles", "id", userId);
  if (!before) throw problem(404, "User not found.");
  const patch = {
    account_status: status,
    status_reason: clean(body.reason),
    suspended_at: status === "suspended" ? new Date().toISOString() : null
  };
  const { data, error } = await db.from("profiles").update(patch).eq("id", userId).select("*").single();
  if (error) throw error;
  await audit(ctx, "update_user_status", "profile", userId, before, data, { reason: clean(body.reason) });
  return { profile: data };
}

async function addUserNote(ctx: AdminContext, userId: string, body: AnyRecord): Promise<AnyRecord> {
  const noteText = clean(body.noteText || body.note);
  if (!noteText) throw problem(400, "Note text is required.");
  const row = { user_id: userId, author_user_id: ctx.user.id, note_text: noteText };
  const { data, error } = await db.from("admin_user_notes").insert(row).select("*").single();
  if (error) throw error;
  await audit(ctx, "create_user_note", "admin_user_note", data.id, {}, data, { userId });
  return { note: data };
}

async function listUserNotes(userId: string): Promise<AnyRecord> {
  const { data, error } = await db
    .from("admin_user_notes")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return { notes: data || [] };
}

async function listUserCvDocuments(userId: string): Promise<AnyRecord> {
  const { data, error } = await db
    .from("cv_documents")
    .select("*")
    .eq("user_id", userId)
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return { cvDocuments: data || [] };
}

async function listUserSavedJobs(userId: string): Promise<AnyRecord> {
  const { data, error } = await db
    .from("saved_jobs")
    .select("*")
    .eq("user_id", userId)
    .order("saved_at", { ascending: false });
  if (error) throw error;
  const rows = data || [];
  const jobsById = await jobsByIds(rows.map((row: AnyRecord) => row.job_id));
  return {
    savedJobs: rows.map((row: AnyRecord) => ({
      ...row,
      job: jobsById.get(row.job_id) || null
    }))
  };
}

async function listUserApplications(userId: string): Promise<AnyRecord> {
  const { data, error } = await db
    .from("applications")
    .select("*")
    .eq("user_id", userId)
    .order("started_at", { ascending: false });
  if (error) throw error;
  const rows = data || [];
  const jobsById = await jobsByIds(rows.map((row: AnyRecord) => row.job_id));
  return {
    applications: rows.map((row: AnyRecord) => ({
      ...row,
      job: jobsById.get(row.job_id) || null
    }))
  };
}

async function listUserNotifications(userId: string): Promise<AnyRecord> {
  const { data, error } = await db
    .from("notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return { notifications: data || [] };
}

async function listUserAccountEvents(userId: string): Promise<AnyRecord[]> {
  const { data, error } = await db
    .from("account_events")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

async function listJobs(params: URLSearchParams): Promise<AnyRecord> {
  const pagination = pageParams(params, 25, 200);
  let query = db
    .from("admin_job_review_queue_v")
    .select("*", { count: "exact" })
    .order("posted_at", { ascending: false });
  const search = searchTerm(params.get("query"));
  const source = clean(params.get("source"));
  const visibility = clean(params.get("visibility"));
  const review = clean(params.get("review"));
  if (search) query = query.or(`title.ilike.%${search}%,company.ilike.%${search}%,location_text.ilike.%${search}%`);
  if (source) query = query.ilike("source", `%${source}%`);
  if (VISIBILITY_STATES.includes(visibility)) query = query.eq("visibility_status", visibility);
  if (REVIEW_STATES.includes(review)) query = query.eq("review_state", review);
  const { data, count, error } = await query.range(pagination.from, pagination.to);
  if (error) throw error;
  return { page: pagination.page, limit: pagination.limit, total: count || 0, jobs: data || [] };
}

async function getJobDetail(jobId: string): Promise<AnyRecord> {
  const [job, moderation] = await Promise.all([
    getSingle("jobs", "id", jobId),
    getSingle("job_moderation", "job_id", jobId)
  ]);
  if (!job) throw problem(404, "Job not found.");
  const publicJob = overlayJob(job, moderation || {});
  const [{ count: savedCount, error: savedError }, { count: applicationCount, error: applicationError }] = await Promise.all([
    db.from("saved_jobs").select("job_id", { count: "exact", head: true }).eq("job_id", jobId),
    db.from("applications").select("job_id", { count: "exact", head: true }).eq("job_id", jobId)
  ]);
  if (savedError) throw savedError;
  if (applicationError) throw applicationError;
  return {
    job,
    moderation: moderation || defaultModeration(jobId),
    publicJob,
    stats: {
      savedCount: savedCount || 0,
      applicationCount: applicationCount || 0
    }
  };
}

async function getJobRawPayload(jobId: string): Promise<AnyRecord> {
  const job = await getSingle("jobs", "id", jobId);
  if (!job) throw problem(404, "Job not found.");
  return { jobId, rawPayload: job.raw_payload || {} };
}

async function updateJobModeration(ctx: AdminContext, jobId: string, body: AnyRecord): Promise<AnyRecord> {
  const before = await getSingle("job_moderation", "job_id", jobId);
  const patch = moderationPatch(body, ctx.user.id, jobId, before || {});
  const { data, error } = await db
    .from("job_moderation")
    .upsert(patch, { onConflict: "job_id" })
    .select("*")
    .single();
  if (error) throw error;
  await audit(ctx, "update_job_moderation", "job_moderation", jobId, before || {}, data, {});
  return { moderation: data };
}

async function bulkModerateJobs(ctx: AdminContext, body: AnyRecord): Promise<AnyRecord> {
  const jobIds = listOf(body.jobIds || body.ids);
  if (!jobIds.length) throw problem(400, "Job ids are required.");
  const changes = body.action ? moderationChangesFromAction(body.action, body) : body.changes || body;
  const { data: existingRows, error: existingError } = await db.from("job_moderation").select("*").in("job_id", jobIds);
  if (existingError) throw existingError;
  const existingByJobId = new Map((existingRows || []).map((row: AnyRecord) => [row.job_id, row]));
  const rows = jobIds.map((jobId) => moderationPatch(changes, ctx.user.id, jobId, existingByJobId.get(jobId) || {}));
  const { error } = await db.from("job_moderation").upsert(rows, { onConflict: "job_id" });
  if (error) throw error;
  await audit(ctx, "bulk_job_moderation", "job_moderation", jobIds.join(","), {}, { jobIds, changes }, {});
  return { updated: jobIds.length };
}

async function listSources(): Promise<AnyRecord> {
  const [{ data: sources, error: sourcesError }, { data: health, error: healthError }] = await Promise.all([
    db.from("job_sources").select("*").order("source_type", { ascending: true }).order("name", { ascending: true }),
    db.from("admin_source_health_v").select("*")
  ]);
  if (sourcesError) throw sourcesError;
  if (healthError) throw healthError;
  const healthById = new Map((health || []).map((row: AnyRecord) => [row.id, row]));
  return {
    sources: (sources || []).map((row: AnyRecord) => ({
      ...row,
      health: healthById.get(row.id) || null
    }))
  };
}

async function createSource(ctx: AdminContext, body: AnyRecord): Promise<AnyRecord> {
  const sourceType = clean(body.sourceType || body.source_type);
  if (!SOURCE_TYPES.includes(sourceType)) throw problem(400, "Invalid source type.");
  const row = {
    source_type: sourceType,
    name: clean(body.name),
    is_enabled: body.isEnabled !== false,
    config: jsonValue(body.config),
    secret_refs: jsonValue(body.secretRefs || body.secret_refs),
    schedule: jsonValue(body.schedule),
    created_by: ctx.user.id,
    updated_by: ctx.user.id
  };
  if (!row.name) throw problem(400, "Source name is required.");
  const { data, error } = await db.from("job_sources").insert(row).select("*").single();
  if (error) throw error;
  await audit(ctx, "create_source", "job_source", data.id, {}, data, {});
  return { source: data };
}

async function updateSource(ctx: AdminContext, sourceId: string, body: AnyRecord): Promise<AnyRecord> {
  const before = await getSingle("job_sources", "id", sourceId);
  if (!before) throw problem(404, "Source not found.");
  const sourceType = clean(body.sourceType || body.source_type || before.source_type);
  if (!SOURCE_TYPES.includes(sourceType)) throw problem(400, "Invalid source type.");
  const patch = {
    source_type: sourceType,
    name: clean(body.name || before.name),
    is_enabled: typeof body.isEnabled === "boolean" ? body.isEnabled : typeof body.is_enabled === "boolean" ? body.is_enabled : before.is_enabled,
    config: body.config === undefined ? before.config : jsonValue(body.config),
    secret_refs: body.secretRefs === undefined && body.secret_refs === undefined ? before.secret_refs : jsonValue(body.secretRefs || body.secret_refs),
    schedule: body.schedule === undefined ? before.schedule : jsonValue(body.schedule),
    updated_by: ctx.user.id
  };
  const { data, error } = await db.from("job_sources").update(patch).eq("id", sourceId).select("*").single();
  if (error) throw error;
  await audit(ctx, "update_source", "job_source", sourceId, before, data, {});
  return { source: data };
}

async function testSource(ctx: AdminContext, sourceId: string): Promise<AnyRecord> {
  const source = await getSingle("job_sources", "id", sourceId);
  if (!source) throw problem(404, "Source not found.");
  const startedAt = new Date().toISOString();
  try {
    const adapter = sourceAdapterFromRow(source);
    const jobs = normalizeMany(await adapter.fetchJobs());
    const patch = {
      last_tested_at: new Date().toISOString(),
      last_success_at: jobs.length ? new Date().toISOString() : source.last_success_at,
      updated_by: ctx.user.id
    };
    const { error } = await db.from("job_sources").update(patch).eq("id", sourceId);
    if (error) throw error;
    await audit(ctx, "test_source", "job_source", sourceId, {}, { fetchedCount: jobs.length }, {});
    return {
      sourceId,
      startedAt,
      finishedAt: new Date().toISOString(),
      fetchedCount: jobs.length,
      sampleJobs: jobs.slice(0, 3)
    };
  } catch (error) {
    const { error: updateError } = await db.from("job_sources").update({ last_tested_at: new Date().toISOString(), updated_by: ctx.user.id }).eq("id", sourceId);
    if (updateError) console.error(updateError);
    throw problem(400, formatError(error));
  }
}

async function listIngestionRuns(params: URLSearchParams): Promise<AnyRecord> {
  const pagination = pageParams(params, 20, 200);
  const { data, count, error } = await db
    .from("ingestion_runs")
    .select("*", { count: "exact" })
    .order("started_at", { ascending: false })
    .range(pagination.from, pagination.to);
  if (error) throw error;
  return { page: pagination.page, limit: pagination.limit, total: count || 0, runs: data || [] };
}

async function getIngestionRun(runId: string): Promise<AnyRecord> {
  const run = await getSingle("ingestion_runs", "id", runId);
  if (!run) throw problem(404, "Run not found.");
  return { run };
}

async function listIngestionRunSources(runId: string): Promise<AnyRecord> {
  const { data, error } = await db
    .from("source_run_reports")
    .select("*")
    .eq("ingestion_run_id", runId)
    .order("started_at", { ascending: false });
  if (error) throw error;
  return { sources: data || [] };
}

async function runSources(ctx: AdminContext, sourceIds: string[]): Promise<AnyRecord> {
  const rows = await listSourceRows(sourceIds);
  if (!rows.length) throw problem(404, "No sources found.");
  const result = await runManagedIngestion(rows, "admin");
  await audit(ctx, sourceIds.length ? "run_selected_sources" : "run_ingestion", "ingestion_run", result.run.id, {}, result.run, { sourceIds });
  return result;
}

async function listTemplates(): Promise<AnyRecord> {
  const { data, error } = await db
    .from("template_catalog")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return { templates: data || [] };
}

async function updateTemplate(ctx: AdminContext, templateId: string, body: AnyRecord): Promise<AnyRecord> {
  const before = await getSingle("template_catalog", "id", templateId);
  if (!before) throw problem(404, "Template not found.");
  const patch = {
    name: clean(body.name || before.name),
    short_name: clean(body.shortName || body.short_name || before.short_name),
    description: clean(body.description ?? before.description),
    audience: clean(body.audience ?? before.audience),
    preview_palette_id: clean(body.previewPaletteId || body.preview_palette_id || before.preview_palette_id),
    sort_order: int(body.sortOrder ?? body.sort_order, before.sort_order),
    is_enabled: typeof body.isEnabled === "boolean" ? body.isEnabled : typeof body.is_enabled === "boolean" ? body.is_enabled : before.is_enabled,
    is_featured: typeof body.isFeatured === "boolean" ? body.isFeatured : typeof body.is_featured === "boolean" ? body.is_featured : before.is_featured,
    updated_by: ctx.user.id
  };
  const { data, error } = await db.from("template_catalog").update(patch).eq("id", templateId).select("*").single();
  if (error) throw error;
  await audit(ctx, "update_template", "template_catalog", templateId, before, data, {});
  return { template: data };
}

async function listPalettes(): Promise<AnyRecord> {
  const { data, error } = await db
    .from("palette_catalog")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return { palettes: data || [] };
}

async function updatePalette(ctx: AdminContext, paletteId: string, body: AnyRecord): Promise<AnyRecord> {
  const before = await getSingle("palette_catalog", "id", paletteId);
  if (!before) throw problem(404, "Palette not found.");
  const patch = {
    name: clean(body.name || before.name),
    description: clean(body.description ?? before.description),
    tokens: body.tokens === undefined ? before.tokens : jsonValue(body.tokens),
    sort_order: int(body.sortOrder ?? body.sort_order, before.sort_order),
    is_enabled: typeof body.isEnabled === "boolean" ? body.isEnabled : typeof body.is_enabled === "boolean" ? body.is_enabled : before.is_enabled,
    updated_by: ctx.user.id
  };
  const { data, error } = await db.from("palette_catalog").update(patch).eq("id", paletteId).select("*").single();
  if (error) throw error;
  await audit(ctx, "update_palette", "palette_catalog", paletteId, before, data, {});
  return { palette: data };
}

async function listContent(params: URLSearchParams): Promise<AnyRecord> {
  let query = db
    .from("content_blocks")
    .select("*")
    .order("section", { ascending: true })
    .order("key", { ascending: true });
  const section = clean(params.get("section"));
  const status = clean(params.get("status"));
  if (section) query = query.eq("section", section);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return { content: data || [] };
}

async function getContentBlock(key: string): Promise<AnyRecord> {
  const block = await getSingle("content_blocks", "key", key);
  if (!block) throw problem(404, "Content block not found.");
  return { block };
}

async function updateContentBlock(ctx: AdminContext, key: string, body: AnyRecord): Promise<AnyRecord> {
  const before = await getSingle("content_blocks", "key", key);
  const status = clean(body.status || before?.status || "draft");
  if (!["draft", "published"].includes(status)) throw problem(400, "Invalid content status.");
  const row = {
    key,
    section: clean(body.section || before?.section),
    locale: clean(body.locale || before?.locale || "en-ZA"),
    content: body.content === undefined ? before?.content || {} : jsonValue(body.content),
    status,
    updated_by: ctx.user.id,
    published_at: status === "published" ? new Date().toISOString() : before?.published_at || null
  };
  const { data, error } = await db.from("content_blocks").upsert(row, { onConflict: "key" }).select("*").single();
  if (error) throw error;
  await audit(ctx, "update_content", "content_block", key, before || {}, data, {});
  return { block: data };
}

async function listSettings(): Promise<AnyRecord> {
  const { data, error } = await db.from("platform_settings").select("*").order("key", { ascending: true });
  if (error) throw error;
  return { settings: data || [] };
}

async function updateSetting(ctx: AdminContext, key: string, body: AnyRecord): Promise<AnyRecord> {
  const before = await getSingle("platform_settings", "key", key);
  if (!before) throw problem(404, "Setting not found.");
  const patch = {
    value: body.value === undefined ? before.value : jsonValue(body.value),
    description: clean(body.description ?? before.description),
    updated_by: ctx.user.id
  };
  const { data, error } = await db.from("platform_settings").update(patch).eq("key", key).select("*").single();
  if (error) throw error;
  await audit(ctx, "update_setting", "platform_setting", key, before, data, {});
  return { setting: data };
}

async function listFeatureFlags(): Promise<AnyRecord> {
  const { data, error } = await db.from("feature_flags").select("*").order("key", { ascending: true });
  if (error) throw error;
  return { flags: data || [] };
}

async function updateFeatureFlag(ctx: AdminContext, key: string, body: AnyRecord): Promise<AnyRecord> {
  const before = await getSingle("feature_flags", "key", key);
  if (!before) throw problem(404, "Feature flag not found.");
  const patch = {
    enabled: typeof body.enabled === "boolean" ? body.enabled : before.enabled,
    rules: body.rules === undefined ? before.rules : jsonValue(body.rules),
    description: clean(body.description ?? before.description),
    updated_by: ctx.user.id
  };
  const { data, error } = await db.from("feature_flags").update(patch).eq("key", key).select("*").single();
  if (error) throw error;
  await audit(ctx, "update_feature_flag", "feature_flag", key, before, data, {});
  return { flag: data };
}

async function listNotificationDeliveries(params: URLSearchParams): Promise<AnyRecord> {
  const pagination = pageParams(params, 25, 200);
  let query = db
    .from("notification_deliveries")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });
  const status = clean(params.get("status"));
  const channel = clean(params.get("channel"));
  if (status) query = query.eq("status", status);
  if (channel) query = query.eq("channel", channel);
  const { data, count, error } = await query.range(pagination.from, pagination.to);
  if (error) throw error;
  return { page: pagination.page, limit: pagination.limit, total: count || 0, deliveries: await enrichDeliveries(data || []) };
}

async function listNotificationFailures(params: URLSearchParams): Promise<AnyRecord> {
  const pagination = pageParams(params, 25, 200);
  const { data, count, error } = await db
    .from("admin_notification_failures_v")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(pagination.from, pagination.to);
  if (error) throw error;
  return { page: pagination.page, limit: pagination.limit, total: count || 0, failures: data || [] };
}

async function listCampaigns(): Promise<AnyRecord> {
  const { data, error } = await db
    .from("admin_notification_campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return { campaigns: data || [] };
}

async function createCampaign(ctx: AdminContext, body: AnyRecord): Promise<AnyRecord> {
  const row = {
    type: clean(body.type || "account_notice"),
    audience: jsonValue(body.audience),
    title: clean(body.title),
    body: jsonValue(body.body),
    action_url: clean(body.actionUrl || body.action_url),
    status: CAMPAIGN_STATUS.includes(clean(body.status)) ? clean(body.status) : "draft",
    scheduled_at: clean(body.scheduledAt || body.scheduled_at) || null,
    created_by: ctx.user.id,
    updated_by: ctx.user.id
  };
  if (!row.title) throw problem(400, "Campaign title is required.");
  const { data, error } = await db.from("admin_notification_campaigns").insert(row).select("*").single();
  if (error) throw error;
  await audit(ctx, "create_campaign", "notification_campaign", data.id, {}, data, {});
  return { campaign: data };
}

async function updateCampaign(ctx: AdminContext, campaignId: string, body: AnyRecord): Promise<AnyRecord> {
  const before = await getSingle("admin_notification_campaigns", "id", campaignId);
  if (!before) throw problem(404, "Campaign not found.");
  const status = clean(body.status || before.status);
  if (!CAMPAIGN_STATUS.includes(status)) throw problem(400, "Invalid campaign status.");
  const patch = {
    type: clean(body.type || before.type),
    audience: body.audience === undefined ? before.audience : jsonValue(body.audience),
    title: clean(body.title || before.title),
    body: body.body === undefined ? before.body : jsonValue(body.body),
    action_url: clean(body.actionUrl || body.action_url || before.action_url),
    status,
    scheduled_at: clean(body.scheduledAt || body.scheduled_at) || before.scheduled_at || null,
    updated_by: ctx.user.id
  };
  const { data, error } = await db.from("admin_notification_campaigns").update(patch).eq("id", campaignId).select("*").single();
  if (error) throw error;
  await audit(ctx, "update_campaign", "notification_campaign", campaignId, before, data, {});
  return { campaign: data };
}

async function sendCampaign(ctx: AdminContext, campaignId: string): Promise<AnyRecord> {
  const campaign = await getSingle("admin_notification_campaigns", "id", campaignId);
  if (!campaign) throw problem(404, "Campaign not found.");
  if (campaign.status === "cancelled") throw problem(400, "Cancelled campaigns cannot be sent.");
  if (campaign.status === "sent") throw problem(409, "Campaign already sent.");

  const recipients = await audienceProfiles(campaign.audience || {});
  const bodyText = campaignBodyText(campaign.body);
  const now = new Date().toISOString();
  const notificationRows = recipients
    .filter((item) => item.preferences?.in_app_enabled !== false)
    .map((item) => ({
      user_id: item.profile.id,
      type: clean(campaign.type || "account_notice"),
      title: clean(campaign.title),
      body: bodyText,
      action_url: clean(campaign.action_url || `#notifications?campaign=${campaignId}`),
      payload: {
        campaignId,
        audience: campaign.audience || {}
      }
    }));

  let notifications: AnyRecord[] = [];
  if (notificationRows.length) {
    const { data, error } = await db.from("notifications").insert(notificationRows).select("*");
    if (error) throw error;
    notifications = data || [];
  }

  if (notifications.length) {
    const { error } = await db.from("notification_deliveries").insert(
      notifications.map((item) => ({
        notification_id: item.id,
        channel: "in_app",
        status: "sent",
        sent_at: now
      }))
    );
    if (error) throw error;
  }

  const emailTargets = recipients.filter((item) => item.preferences?.email_product_updates === true && item.profile?.email);
  let emailed = 0;
  for (const target of emailTargets) {
    const notification = notifications.find((item) => item.user_id === target.profile.id);
    const sent = await sendCampaignEmail(target.profile, notification, campaign.title, bodyText, absoluteActionUrl(campaign.action_url, campaignId));
    if (sent) emailed += 1;
  }

  const { data: updated, error: updateError } = await db
    .from("admin_notification_campaigns")
    .update({ status: "sent", sent_at: now, updated_by: ctx.user.id })
    .eq("id", campaignId)
    .select("*")
    .single();
  if (updateError) throw updateError;

  await audit(ctx, "send_campaign", "notification_campaign", campaignId, campaign, updated, {
    recipientCount: recipients.length,
    inAppCount: notifications.length,
    emailCount: emailed
  });

  return {
    campaign: updated,
    recipientCount: recipients.length,
    inAppCount: notifications.length,
    emailCount: emailed
  };
}

async function listAuditLogs(params: URLSearchParams): Promise<AnyRecord> {
  const pagination = pageParams(params, 30, 200);
  let query = db
    .from("admin_audit_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });
  const actorUserId = clean(params.get("actorUserId"));
  const action = clean(params.get("action"));
  const subjectType = clean(params.get("subjectType"));
  const from = clean(params.get("from"));
  const to = clean(params.get("to"));
  if (actorUserId) query = query.eq("actor_user_id", actorUserId);
  if (action) query = query.eq("action", action);
  if (subjectType) query = query.eq("subject_type", subjectType);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);
  const { data, count, error } = await query.range(pagination.from, pagination.to);
  if (error) throw error;
  return { page: pagination.page, limit: pagination.limit, total: count || 0, logs: data || [] };
}

async function listAdminMemberships(): Promise<AnyRecord> {
  const { data, error } = await db
    .from("admin_memberships")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = data || [];
  const profiles = await profilesByIds(rows.map((row: AnyRecord) => row.user_id));
  return {
    memberships: rows.map((row: AnyRecord) => ({
      ...row,
      profile: profiles.get(row.user_id) || null
    }))
  };
}

async function createAdminMembership(ctx: AdminContext, body: AnyRecord): Promise<AnyRecord> {
  const userId = await resolveTargetUserId(body);
  const role = clean(body.role);
  const status = clean(body.status || "active");
  if (!ROLES.includes(role)) throw problem(400, "Invalid admin role.");
  if (!MEMBERSHIP_STATUS.includes(status)) throw problem(400, "Invalid admin status.");
  if (role === "owner" && ctx.membership?.role !== "owner") throw problem(403, "Only the owner can assign owner access.");
  const before = await getSingle("admin_memberships", "user_id", userId);
  const row = {
    user_id: userId,
    role,
    status,
    assigned_by: ctx.user.id,
    assigned_at: new Date().toISOString(),
    last_seen_at: before?.last_seen_at || null
  };
  const { data, error } = await db.from("admin_memberships").upsert(row, { onConflict: "user_id" }).select("*").single();
  if (error) throw error;
  await audit(ctx, "create_admin_membership", "admin_membership", userId, before || {}, data, {});
  return { membership: data };
}

async function updateAdminMembership(ctx: AdminContext, userId: string, body: AnyRecord): Promise<AnyRecord> {
  const before = await getSingle("admin_memberships", "user_id", userId);
  if (!before) throw problem(404, "Admin membership not found.");
  const nextRole = clean(body.role || before.role);
  const nextStatus = clean(body.status || before.status);
  if (!ROLES.includes(nextRole)) throw problem(400, "Invalid admin role.");
  if (!MEMBERSHIP_STATUS.includes(nextStatus)) throw problem(400, "Invalid admin status.");
  if ((before.role === "owner" || nextRole === "owner") && ctx.membership?.role !== "owner") {
    throw problem(403, "Only the owner can manage owner access.");
  }
  await ensureOwnerCoverage(userId, before, nextRole, nextStatus);
  const patch = {
    role: nextRole,
    status: nextStatus,
    assigned_by: ctx.user.id,
    assigned_at: new Date().toISOString()
  };
  const { data, error } = await db.from("admin_memberships").update(patch).eq("user_id", userId).select("*").single();
  if (error) throw error;
  await audit(ctx, "update_admin_membership", "admin_membership", userId, before, data, {});
  return { membership: data };
}

async function ensureOwnerCoverage(userId: string, before: AnyRecord, nextRole: string, nextStatus: string): Promise<void> {
  if (before.role !== "owner" || (nextRole === "owner" && nextStatus === "active")) return;
  const { count, error } = await db
    .from("admin_memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("role", "owner")
    .eq("status", "active");
  if (error) throw error;
  if (Number(count || 0) <= 1) throw problem(400, "At least one active owner is required.");
  if (before.user_id === userId && nextStatus !== "active") throw problem(400, "The last owner cannot suspend owner access.");
}

async function resolveTargetUserId(body: AnyRecord): Promise<string> {
  const userId = clean(body.userId || body.user_id);
  if (userId) return userId;
  const email = clean(body.email).toLowerCase();
  if (!email) throw problem(400, "Target user is required.");
  const { data, error } = await db.from("profiles").select("id").ilike("email", email).maybeSingle();
  if (error) throw error;
  if (!data?.id) throw problem(404, "User could not be found.");
  return data.id;
}

async function audienceProfiles(audience: AnyRecord): Promise<AnyRecord[]> {
  let query = db.from("profiles").select("*").eq("account_status", "active");
  const userIds = listOf(audience.userIds || audience.user_ids);
  if (userIds.length) query = query.in("id", userIds);
  const { data: profiles, error: profilesError } = await query;
  if (profilesError) throw profilesError;
  const ids = (profiles || []).map((row: AnyRecord) => row.id);
  const { data: preferences, error: preferencesError } = await db.from("notification_preferences").select("*").in("user_id", ids.length ? ids : [crypto.randomUUID()]);
  if (preferencesError) throw preferencesError;
  const prefById = new Map((preferences || []).map((row: AnyRecord) => [row.user_id, row]));
  return (profiles || []).map((profile: AnyRecord) => ({
    profile,
    preferences: prefById.get(profile.id) || null
  }));
}

async function sendCampaignEmail(profile: AnyRecord, notification: AnyRecord | undefined, title: string, bodyText: string, actionUrl: string): Promise<boolean> {
  const apiKey = Deno.env.get("RESEND_API_KEY") || "";
  const from = Deno.env.get("NOTIFICATION_FROM_EMAIL") || "";
  const to = clean(profile?.email);
  if (!apiKey || !from || !to) return false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from,
        to,
        subject: clean(title) || "SearchR update",
        html: `<p>${escapeHtmlText(bodyText)}</p><p><a href="${escapeHtmlAttribute(actionUrl)}">Open SearchR</a></p>`
      })
    });
    const payload = await response.json().catch(() => ({}));
    const status = response.ok ? "sent" : "failed";
    if (notification?.id) {
      await db.from("notification_deliveries").insert({
        notification_id: notification.id,
        channel: "email",
        status,
        provider_message_id: clean(payload?.id),
        error_text: response.ok ? "" : clean(payload?.message) || `HTTP ${response.status}`,
        sent_at: response.ok ? new Date().toISOString() : null
      });
    }
    return response.ok;
  } catch (error) {
    if (notification?.id) {
      await db.from("notification_deliveries").insert({
        notification_id: notification.id,
        channel: "email",
        status: "failed",
        provider_message_id: "",
        error_text: formatError(error)
      });
    }
    return false;
  }
}

async function listSourceRows(sourceIds: string[]): Promise<AnyRecord[]> {
  let query = db
    .from("job_sources")
    .select("*")
    .eq("is_enabled", true)
    .order("created_at", { ascending: true });
  if (sourceIds.length) query = query.in("id", sourceIds);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

function sourceAdapterFromRow(row: AnyRecord): AnyRecord {
  const base = loadSourceConfig(Deno.env);
  if (row.source_type === "adzuna_query_set") {
    return configuredSources({
      adzuna: {
        appId: base.adzuna.appId,
        appKey: base.adzuna.appKey,
        queries: listOf(row.config?.queries || base.adzuna.queries),
        locations: listOf(row.config?.locations || base.adzuna.locations),
        resultsPerQuery: int(row.config?.resultsPerQuery, base.adzuna.resultsPerQuery)
      },
      greenhouseBoards: [],
      leverCompanies: [],
      partnerFeedUrls: []
    })[0];
  }
  if (row.source_type === "greenhouse_board") {
    return configuredSources({
      adzuna: { appId: "", appKey: "", queries: [], locations: [], resultsPerQuery: 20 },
      greenhouseBoards: [clean(row.config?.boardToken || row.config?.board || row.config?.url)],
      leverCompanies: [],
      partnerFeedUrls: []
    })[0];
  }
  if (row.source_type === "lever_board") {
    return configuredSources({
      adzuna: { appId: "", appKey: "", queries: [], locations: [], resultsPerQuery: 20 },
      greenhouseBoards: [],
      leverCompanies: [clean(row.config?.companySlug || row.config?.slug || row.config?.url)],
      partnerFeedUrls: []
    })[0];
  }
  return configuredSources({
    adzuna: { appId: "", appKey: "", queries: [], locations: [], resultsPerQuery: 20 },
    greenhouseBoards: [],
    leverCompanies: [],
    partnerFeedUrls: [clean(row.config?.feedUrl || row.config?.url)]
  })[0];
}

async function runManagedIngestion(sourceRows: AnyRecord[], reason: string): Promise<AnyRecord> {
  const startedAt = new Date().toISOString();
  const reports: AnyRecord[] = [];
  let fetchedCount = 0;
  let upsertedCount = 0;
  let failedCount = 0;

  for (const row of sourceRows) {
    const report = {
      rowId: row.id,
      sourceKey: "",
      name: row.name,
      fetched: 0,
      upserted: 0,
      failed: 0,
      error: "",
      startedAt: new Date().toISOString(),
      finishedAt: ""
    };
    try {
      const adapter = sourceAdapterFromRow(row);
      if (!adapter?.enabled) {
        report.error = "Source is not enabled by its current configuration.";
      } else {
        report.sourceKey = adapter.id;
        const rawJobs = await adapter.fetchJobs();
        const jobs = normalizeMany(rawJobs);
        report.fetched = rawJobs.length;
        report.upserted = await upsertJobs(jobs);
        fetchedCount += report.fetched;
        upsertedCount += report.upserted;
        const { error } = await db.from("job_sources").update({ last_success_at: new Date().toISOString() }).eq("id", row.id);
        if (error) throw error;
      }
    } catch (error) {
      report.failed = 1;
      report.error = formatError(error);
      failedCount += 1;
    }
    report.finishedAt = new Date().toISOString();
    reports.push(report);
  }

  await markExpiredJobs();

  const run = {
    id: `run-${Date.now()}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    fetchedCount,
    upsertedCount,
    failedCount,
    sources: reports,
    reason
  };

  const { error: runError } = await db.from("ingestion_runs").insert({
    id: run.id,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    fetched_count: run.fetchedCount,
    upserted_count: run.upsertedCount,
    failed_count: run.failedCount,
    sources: run.sources
  });
  if (runError) throw runError;

  if (reports.length) {
    const { error: reportsError } = await db.from("source_run_reports").insert(
      reports.map((report) => ({
        ingestion_run_id: run.id,
        job_source_id: report.rowId,
        source_key: report.sourceKey,
        fetched_count: report.fetched,
        upserted_count: report.upserted,
        failed_count: report.failed,
        error_text: report.error,
        started_at: report.startedAt,
        finished_at: report.finishedAt
      }))
    );
    if (reportsError) throw reportsError;
  }

  return { run, totalJobs: await countPublicJobs() };
}

async function upsertJobs(jobs: AnyRecord[]): Promise<number> {
  const uniqueJobs = uniqueJobsById(jobs);
  if (!uniqueJobs.length) return 0;
  const now = new Date().toISOString();
  const existing = await existingFirstSeen(uniqueJobs.map((job) => job.id));
  const rows = uniqueJobs.map((job) => ({
    id: job.id,
    source: job.source,
    external_id: job.externalId,
    canonical_url: job.canonicalUrl,
    apply_url: job.applyUrl,
    title: job.title,
    company: job.company,
    description_text: job.descriptionText,
    location_text: job.locationText,
    workplace_type: job.workplaceType,
    employment_type: job.employmentType,
    salary_min: job.salaryMin,
    salary_max: job.salaryMax,
    salary_currency: job.salaryCurrency,
    posted_at: job.postedAt,
    expires_at: job.expiresAt,
    status: "active",
    category: job.category,
    requirements: job.requirements || {},
    content_hash: job.contentHash,
    raw_payload: job.rawPayload || {},
    first_seen_at: existing.get(job.id) || now,
    last_seen_at: now,
    updated_at: now
  }));
  for (const chunk of chunks(rows, 20)) {
    const { error } = await db.from("jobs").upsert(chunk, { onConflict: "id" });
    if (error) throw error;
  }
  return uniqueJobs.length;
}

async function existingFirstSeen(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const chunk of chunks(ids, 20)) {
    const { data, error } = await db.from("jobs").select("id,first_seen_at").in("id", chunk);
    if (error) throw error;
    (data || []).forEach((row: AnyRecord) => map.set(row.id, row.first_seen_at));
  }
  return map;
}

async function markExpiredJobs(): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db
    .from("jobs")
    .update({ status: "expired", updated_at: now })
    .neq("expires_at", "")
    .lt("expires_at", now);
  if (error) throw error;
}

async function countPublicJobs(): Promise<number> {
  const { count, error } = await db.from("public_jobs_v").select("id", { count: "exact", head: true }).neq("status", "expired");
  if (error) throw error;
  return count || 0;
}

async function enrichDeliveries(rows: AnyRecord[]): Promise<AnyRecord[]> {
  if (!rows.length) return [];
  const notificationIds = uniqueValues(rows.map((row) => row.notification_id));
  const { data: notifications, error: notificationsError } = await db
    .from("notifications")
    .select("*")
    .in("id", notificationIds);
  if (notificationsError) throw notificationsError;
  const notificationById = new Map((notifications || []).map((row: AnyRecord) => [row.id, row]));
  const profiles = await profilesByIds((notifications || []).map((row: AnyRecord) => row.user_id));
  return rows.map((row) => {
    const notification = notificationById.get(row.notification_id) || null;
    return {
      ...row,
      notification,
      profile: notification?.user_id ? profiles.get(notification.user_id) || null : null
    };
  });
}

async function jobsByIds(ids: string[]): Promise<Map<string, AnyRecord>> {
  const result = new Map<string, AnyRecord>();
  const uniqueIds = uniqueValues(ids);
  if (!uniqueIds.length) return result;
  for (const chunk of chunks(uniqueIds, 50)) {
    const { data, error } = await db.from("public_jobs_v").select("*").in("id", chunk);
    if (error) throw error;
    (data || []).forEach((row: AnyRecord) => result.set(row.id, row));
  }
  return result;
}

async function profilesByIds(ids: string[]): Promise<Map<string, AnyRecord>> {
  const result = new Map<string, AnyRecord>();
  const uniqueIds = uniqueValues(ids);
  if (!uniqueIds.length) return result;
  for (const chunk of chunks(uniqueIds, 50)) {
    const { data, error } = await db.from("profiles").select("*").in("id", chunk);
    if (error) throw error;
    (data || []).forEach((row: AnyRecord) => result.set(row.id, row));
  }
  return result;
}

async function getSingle(table: string, field: string, value: string): Promise<AnyRecord | null> {
  const { data, error } = await db.from(table).select("*").eq(field, value).maybeSingle();
  if (error) throw error;
  return data || null;
}

function moderationPatch(body: AnyRecord, actorId: string, jobId: string, existing: AnyRecord = {}): AnyRecord {
  const visibilityStatus = clean(body.visibilityStatus || body.visibility_status || existing.visibility_status || "visible");
  const reviewState = clean(body.reviewState || body.review_state || existing.review_state || "approved");
  if (!VISIBILITY_STATES.includes(visibilityStatus)) throw problem(400, "Invalid visibility state.");
  if (!REVIEW_STATES.includes(reviewState)) throw problem(400, "Invalid review state.");
  const hasPinnedRank = hasOwn(body, "pinnedRank") || hasOwn(body, "pinned_rank");
  const rawPinnedRank = hasOwn(body, "pinnedRank") ? body.pinnedRank : body.pinned_rank;
  const pinnedRank = hasPinnedRank
    ? rawPinnedRank === null || clean(rawPinnedRank) === "" ? null : int(rawPinnedRank, 0)
    : existing.pinned_rank ?? null;
  const hasNotes = hasOwn(body, "internalNotes") || hasOwn(body, "internal_notes");
  const hasOverride = hasOwn(body, "overridePayload") || hasOwn(body, "override_payload");
  return {
    job_id: jobId,
    visibility_status: visibilityStatus,
    review_state: reviewState,
    pinned_rank: pinnedRank,
    tags: hasOwn(body, "tags") ? listOf(body.tags) : Array.isArray(existing.tags) ? existing.tags : [],
    internal_notes: hasNotes ? clean(body.internalNotes || body.internal_notes) : clean(existing.internal_notes),
    override_payload: hasOverride ? jsonValue(hasOwn(body, "overridePayload") ? body.overridePayload : body.override_payload) : existing.override_payload || {},
    reviewed_by: actorId,
    reviewed_at: new Date().toISOString(),
    updated_by: actorId
  };
}

function moderationChangesFromAction(action: string, body: AnyRecord): AnyRecord {
  const key = clean(action).toLowerCase();
  if (key === "hide") return { visibilityStatus: "hidden" };
  if (key === "unhide") return { visibilityStatus: "visible" };
  if (key === "feature") return { visibilityStatus: "featured" };
  if (key === "archive") return { visibilityStatus: "archived" };
  if (key === "needs_review") return { reviewState: "needs_review" };
  if (key === "approve") return { reviewState: "approved" };
  return body.changes || {};
}

function overlayJob(job: AnyRecord, moderation: AnyRecord): AnyRecord {
  const overrides = moderation?.override_payload || {};
  return {
    ...job,
    canonical_url: overrides.canonicalUrl || overrides.canonical_url || job.canonical_url,
    apply_url: overrides.applyUrl || overrides.apply_url || job.apply_url,
    title: overrides.title || job.title,
    company: overrides.company || job.company,
    description_text: overrides.descriptionText || overrides.description_text || job.description_text,
    location_text: overrides.locationText || overrides.location_text || job.location_text,
    workplace_type: overrides.workplaceType || overrides.workplace_type || job.workplace_type,
    employment_type: overrides.employmentType || overrides.employment_type || job.employment_type,
    category: overrides.category || job.category,
    requirements: overrides.requirements || job.requirements,
    visibility_status: moderation?.visibility_status || "visible",
    review_state: moderation?.review_state || "approved",
    pinned_rank: moderation?.pinned_rank ?? null,
    tags: moderation?.tags || []
  };
}

function defaultModeration(jobId: string): AnyRecord {
  return {
    job_id: jobId,
    visibility_status: "visible",
    review_state: "approved",
    pinned_rank: null,
    tags: [],
    internal_notes: "",
    override_payload: {}
  };
}

async function audit(ctx: AdminContext, action: string, subjectType: string, subjectId: string, beforeState: unknown, afterState: unknown, metadata: AnyRecord): Promise<void> {
  const row = {
    actor_user_id: ctx.user.id,
    actor_email: clean(ctx.user.email || ctx.profile?.email),
    action,
    subject_type: subjectType,
    subject_id: clean(subjectId),
    before_state: beforeState || {},
    after_state: afterState || {},
    metadata: metadata || {},
    request_id: ctx.requestId
  };
  const { error } = await db.from("admin_audit_logs").insert(row);
  if (error) console.error(error);
}

function bearerToken(req: Request): string {
  return String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
}

function routePath(pathname: string): string {
  const marker = `/${functionName}`;
  const index = pathname.indexOf(marker);
  if (index >= 0) {
    const rest = pathname.slice(index + marker.length);
    return rest || "/";
  }
  return pathname || "/";
}

function corsHeaders(origin: string | null): HeadersInit {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin = !origin
    ? "*"
    : allowed.length === 0 || allowed.includes(origin)
      ? origin
      : allowed[0] || "*";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400"
  };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

async function readJson(req: Request): Promise<AnyRecord> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw problem(400, "Invalid JSON body.");
  }
}

function pageParams(params: URLSearchParams, defaultLimit: number, maxLimit: number): AnyRecord {
  const page = Math.max(1, int(params.get("page"), 1));
  const limit = clamp(int(params.get("limit"), defaultLimit), 1, maxLimit);
  const from = (page - 1) * limit;
  return { page, limit, from, to: from + limit - 1 };
}

function searchTerm(value: string | null): string {
  return clean(value).replace(/[%_,]/g, " ");
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueValues(value.map((item) => clean(item)).filter(Boolean));
  return uniqueValues(String(value || "").split(",").map((item) => clean(item)).filter(Boolean));
}

function jsonValue(value: unknown): any {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return clean(value);
    }
  }
  return value;
}

function hasOwn(value: AnyRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function problem(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return clean(error.message) || "Request failed.";
  return clean(String(error || "Request failed."));
}

function uniqueValues(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueJobsById(jobs: AnyRecord[]): AnyRecord[] {
  const map = new Map<string, AnyRecord>();
  jobs.forEach((job) => {
    if (job?.id) map.set(job.id, job);
  });
  return [...map.values()];
}

function campaignBodyText(body: AnyRecord): string {
  if (typeof body === "string") return clean(body);
  return clean(body?.text || body?.body || body?.summary || body?.value || "");
}

function absoluteActionUrl(actionUrl: string, campaignId: string): string {
  const text = clean(actionUrl);
  if (!text) return `https://searchr.co.za/#notifications?campaign=${campaignId}`;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith("#")) return `https://searchr.co.za/${text}`;
  return `https://searchr.co.za/${text.replace(/^\//, "")}`;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  const number = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, number));
}

function escapeHtmlText(value: string): string {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll("'", "&#039;");
}
