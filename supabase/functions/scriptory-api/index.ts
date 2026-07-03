import { createClient } from "supabase";
import {
  AnyRecord,
  buildApplicationKit,
  clean,
  configuredSources,
  int,
  loadSourceConfig,
  normalizeJob,
  normalizeMany,
  scoreJob
} from "../_shared/domain.ts";

const functionName = "scriptory-api";
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const adminToken = Deno.env.get("ADMIN_TOKEN") || "";

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const url = new URL(req.url);
    const path = routePath(url.pathname);
    return await route(req, path, url.searchParams, headers);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error(error);
    return json({ error: status === 500 ? "Internal server error" : error.message }, status, headers);
  }
});

async function route(req: Request, path: string, params: URLSearchParams, headers: HeadersInit): Promise<Response> {
  if (path === "/health" && req.method === "GET") {
    return json({ ok: true, service: "searchr-api", runtime: "supabase-edge", time: new Date().toISOString() }, 200, headers);
  }

  if (path === "/v1/sources" && req.method === "GET") {
    const runtime = await loadRuntimeSourceConfig();
    const sources = configuredSources(runtime.settings).map((source) => ({
      id: source.id,
      name: source.name,
      enabled: source.enabled
    }));
    const lastRun = await latestRun();
    return json({ sources, lastRun }, 200, headers);
  }

  if (path === "/v1/content" && req.method === "GET") {
    const content = await loadPublishedContent(params);
    return json({ content }, 200, headers);
  }

  if (path === "/v1/catalog/templates" && req.method === "GET") {
    const templates = await loadTemplateCatalog();
    return json({ templates }, 200, headers);
  }

  if (path === "/v1/catalog/palettes" && req.method === "GET") {
    const palettes = await loadPaletteCatalog();
    return json({ palettes }, 200, headers);
  }

  if (path === "/v1/feature-flags/public" && req.method === "GET") {
    const flags = await loadPublicFeatureFlags();
    return json({ flags }, 200, headers);
  }

  if (path === "/v1/ingest/run" && req.method === "POST") {
    requireAdmin(req);
    const result = await runIngestion("api");
    return json({ run: result.run, totalJobs: result.totalJobs }, 200, headers);
  }

  if (path === "/v1/admin/jobs" && req.method === "POST") {
    requireAdmin(req);
    const body = await readJson(req);
    const incoming = normalizeMany(Array.isArray(body) ? body : body.jobs);
    const upserted = await upsertJobs(incoming);
    const totalJobs = await countJobs();
    return json({ added: upserted, totalJobs }, 200, headers);
  }

  if (path === "/v1/notifications/run" && req.method === "POST") {
    requireAdmin(req);
    const body = await readJson(req);
    const result = await runNotificationWorker(body);
    return json({ result }, 200, headers);
  }

  if (path === "/v1/jobs" && req.method === "GET") {
    const result = await queryJobs(params);
    return json(result, 200, headers);
  }

  const jobId = path.match(/^\/v1\/jobs\/([^/]+)$/)?.[1];
  if (jobId && req.method === "GET") {
    const job = await findJob(decodeURIComponent(jobId));
    if (!job) return json({ error: "Not found" }, 404, headers);
    return json({ job }, 200, headers);
  }

  if (path === "/v1/matches" && req.method === "POST") {
    const body = await readJson(req);
    const cv = body.cv || {};
    const jobs = body.jobs ? normalizeMany(body.jobs) : await loadActiveJobs(int(body.limit, 100));
    const limit = clamp(Number(body.limit || 100), 1, 500);
    const matches = jobs
      .filter((job) => job.status !== "expired")
      .map((job) => ({ job, match: scoreJob(cv, job) }))
      .sort((a, b) => b.match.score - a.match.score)
      .slice(0, limit);
    return json({ matches }, 200, headers);
  }

  if (path === "/v1/application-kits" && req.method === "POST") {
    const body = await readJson(req);
    const cv = body.cv || {};
    const job = body.job ? normalizeJob(body.job) : await findJob(clean(body.jobId));
    if (!job) return json({ error: "Job not found." }, 404, headers);
    const match = scoreJob(cv, job);
    const kit = buildApplicationKit(cv, job, match);
    return json({ job, match, kit }, 200, headers);
  }

  if (path === "/v1/applications" && req.method === "GET") {
    const { data, error } = await db
      .from("applications")
      .select("*")
      .order("started_at", { ascending: false });
    if (error) throw error;
    return json({ applications: (data || []).map(mapApplicationRow) }, 200, headers);
  }

  if (path === "/v1/applications" && req.method === "POST") {
    const body = await readJson(req);
    const now = new Date().toISOString();
    const application = {
      id: `app-${Date.now()}`,
      job_id: clean(body.jobId),
      kit_id: clean(body.kitId),
      status: clean(body.status || "Started"),
      method: clean(body.method || "External"),
      notes: clean(body.notes),
      started_at: now,
      submitted_at: body.status === "Submitted" ? now : null,
      external_application_id: clean(body.externalApplicationId),
      events: [{ status: clean(body.status || "Started"), at: now }]
    };
    const { data, error } = await db.from("applications").insert(application).select("*").single();
    if (error) throw error;
    return json({ application: mapApplicationRow(data) }, 201, headers);
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, headers);
  }

  return json({ error: "Not found" }, 404, headers);
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
    "access-control-allow-methods": "GET,POST,OPTIONS",
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
    const invalid = new Error("Invalid JSON body.") as Error & { statusCode?: number };
    invalid.statusCode = 400;
    throw invalid;
  }
}

function requireAdmin(req: Request): void {
  if (!adminToken) return;
  const token = String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (token !== adminToken) {
    const error = new Error("Admin token required.") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
}

async function loadPublishedContent(params: URLSearchParams): Promise<Record<string, AnyRecord>> {
  const keys = String(params.get("keys") || "")
    .split(",")
    .map((item) => clean(item))
    .filter(Boolean);
  let query = db
    .from("content_blocks")
    .select("key,section,locale,content,status,published_at,updated_at")
    .eq("status", "published")
    .order("section", { ascending: true })
    .order("key", { ascending: true });
  if (keys.length) query = query.in("key", keys);
  const { data, error } = await query;
  if (error) throw error;
  return Object.fromEntries((data || []).map((row: AnyRecord) => [row.key, row]));
}

async function loadTemplateCatalog(): Promise<AnyRecord[]> {
  const { data, error } = await db
    .from("template_catalog")
    .select("*")
    .eq("is_enabled", true)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function loadPaletteCatalog(): Promise<AnyRecord[]> {
  const { data, error } = await db
    .from("palette_catalog")
    .select("*")
    .eq("is_enabled", true)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function loadPublicFeatureFlags(): Promise<Record<string, boolean>> {
  const { data, error } = await db
    .from("feature_flags")
    .select("key,enabled")
    .in("key", ["public_content_blocks", "template_catalog", "job_moderation", "admin_cms"]);
  if (error) throw error;
  return Object.fromEntries((data || []).map((row: AnyRecord) => [row.key, Boolean(row.enabled)]));
}

async function loadRuntimeSourceConfig(): Promise<{ settings: AnyRecord; sourceIdByKey: Map<string, string> }> {
  const base = loadSourceConfig(Deno.env);
  const { data, error } = await db
    .from("job_sources")
    .select("*")
    .eq("is_enabled", true)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) {
    return { settings: base, sourceIdByKey: new Map() };
  }

  const settings = {
    adzuna: {
      appId: base.adzuna.appId,
      appKey: base.adzuna.appKey,
      queries: [] as string[],
      locations: [] as string[],
      resultsPerQuery: base.adzuna.resultsPerQuery
    },
    greenhouseBoards: [] as string[],
    leverCompanies: [] as string[],
    partnerFeedUrls: [] as string[]
  };
  const sourceIdByKey = new Map<string, string>();

  for (const row of rows) {
    const config = row.config || {};
    if (row.source_type === "adzuna_query_set") {
      settings.adzuna.queries.push(...listFromJson(config.queries));
      settings.adzuna.locations.push(...listFromJson(config.locations));
      settings.adzuna.resultsPerQuery = int(config.resultsPerQuery, settings.adzuna.resultsPerQuery);
      const generated = configuredSources({
        adzuna: {
          appId: settings.adzuna.appId,
          appKey: settings.adzuna.appKey,
          queries: settings.adzuna.queries.length ? settings.adzuna.queries : base.adzuna.queries,
          locations: settings.adzuna.locations.length ? settings.adzuna.locations : base.adzuna.locations,
          resultsPerQuery: settings.adzuna.resultsPerQuery
        },
        greenhouseBoards: [],
        leverCompanies: [],
        partnerFeedUrls: []
      })[0];
      if (generated?.id) sourceIdByKey.set(generated.id, row.id);
      continue;
    }
    if (row.source_type === "greenhouse_board") {
      const boardToken = clean(config.boardToken || config.board || config.url);
      if (!boardToken) continue;
      settings.greenhouseBoards.push(boardToken);
      const generated = configuredSources({
        adzuna: { appId: "", appKey: "", queries: [], locations: [], resultsPerQuery: 20 },
        greenhouseBoards: [boardToken],
        leverCompanies: [],
        partnerFeedUrls: []
      })[0];
      if (generated?.id) sourceIdByKey.set(generated.id, row.id);
      continue;
    }
    if (row.source_type === "lever_board") {
      const companySlug = clean(config.companySlug || config.slug || config.url);
      if (!companySlug) continue;
      settings.leverCompanies.push(companySlug);
      const generated = configuredSources({
        adzuna: { appId: "", appKey: "", queries: [], locations: [], resultsPerQuery: 20 },
        greenhouseBoards: [],
        leverCompanies: [companySlug],
        partnerFeedUrls: []
      })[0];
      if (generated?.id) sourceIdByKey.set(generated.id, row.id);
      continue;
    }
    if (row.source_type === "partner_feed") {
      const feedUrl = clean(config.feedUrl || config.url);
      if (!feedUrl) continue;
      settings.partnerFeedUrls.push(feedUrl);
      const generated = configuredSources({
        adzuna: { appId: "", appKey: "", queries: [], locations: [], resultsPerQuery: 20 },
        greenhouseBoards: [],
        leverCompanies: [],
        partnerFeedUrls: [feedUrl]
      })[0];
      if (generated?.id) sourceIdByKey.set(generated.id, row.id);
    }
  }

  settings.adzuna.queries = uniqueList(settings.adzuna.queries.length ? settings.adzuna.queries : base.adzuna.queries);
  settings.adzuna.locations = uniqueList(settings.adzuna.locations.length ? settings.adzuna.locations : base.adzuna.locations);
  settings.greenhouseBoards = uniqueList(settings.greenhouseBoards.length ? settings.greenhouseBoards : base.greenhouseBoards);
  settings.leverCompanies = uniqueList(settings.leverCompanies.length ? settings.leverCompanies : base.leverCompanies);
  settings.partnerFeedUrls = uniqueList(settings.partnerFeedUrls.length ? settings.partnerFeedUrls : base.partnerFeedUrls);

  return { settings, sourceIdByKey };
}

async function queryJobs(params: URLSearchParams): Promise<AnyRecord> {
  const query = clean(params.get("query")).toLowerCase();
  const location = clean(params.get("location")).toLowerCase();
  const source = clean(params.get("source")).toLowerCase();
  const workplace = clean(params.get("workplace")).toLowerCase();
  const limit = clamp(Number(params.get("limit") || 100), 1, 500);
  const offset = clamp(Number(params.get("offset") || 0), 0, 100000);
  const includeExpired = params.get("includeExpired") === "true";

  const rangeSize = Math.max(limit * 3, 60);
  let start = offset;
  const rows: AnyRecord[] = [];
  let totalVisible = 0;

  while (rows.length < limit) {
    const end = start + rangeSize - 1;
    const baseQuery = applyJobFilters(
      db.from("public_jobs_v").select("*", { count: "exact" }),
      { query, location, source, workplace, includeExpired }
    )
      .order("pinned_rank", { ascending: true, nullsFirst: false })
      .order("posted_at", { ascending: false })
      .range(start, end);
    const { data, error, count } = await baseQuery;
    if (error) throw error;
    if (!rows.length) totalVisible = count || 0;
    rows.push(...(data || []));
    if (!data?.length || rows.length >= limit || end >= totalVisible) break;
    start = end + 1;
  }

  const sourceQuery = applyJobFilters(
    db.from("public_jobs_v").select("source"),
    { query, location, source, workplace, includeExpired }
  ).range(0, 9999);
  const { data: sourceRows, error: sourceError } = await sourceQuery;
  if (sourceError) throw sourceError;

  return {
    total: totalVisible,
    limit,
    offset,
    jobs: rows.slice(0, limit).map(mapJobRow),
    sources: summarizeSources((sourceRows || []).map((row: AnyRecord) => row.source))
  };
}

function applyJobFilters(builder: any, filters: AnyRecord): any {
  let query = builder;
  if (!filters.includeExpired) query = query.neq("status", "expired");
  if (filters.query) query = query.ilike("search_text", `%${escapeLike(filters.query)}%`);
  if (filters.location) query = query.ilike("location_text", `%${escapeLike(filters.location)}%`);
  if (filters.source) query = query.ilike("source", `%${escapeLike(filters.source)}%`);
  if (filters.workplace) query = query.eq("workplace_type", filters.workplace);
  return query;
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

function summarizeSources(sources: string[]): AnyRecord[] {
  const counts = new Map<string, number>();
  sources.forEach((source) => counts.set(source || "Unknown", (counts.get(source || "Unknown") || 0) + 1));
  return [...counts.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
}

async function findJob(id: string): Promise<AnyRecord | null> {
  if (!id) return null;
  const { data, error } = await db.from("public_jobs_v").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? mapJobRow(data) : null;
}

async function loadActiveJobs(limit: number): Promise<AnyRecord[]> {
  const { data, error } = await db
    .from("public_jobs_v")
    .select("*")
    .neq("status", "expired")
    .order("pinned_rank", { ascending: true, nullsFirst: false })
    .order("posted_at", { ascending: false })
    .limit(clamp(limit, 1, 500));
  if (error) throw error;
  return (data || []).map(mapJobRow);
}

async function countJobs(): Promise<number> {
  const { count, error } = await db.from("public_jobs_v").select("id", { count: "exact", head: true }).neq("status", "expired");
  if (error) throw error;
  return count || 0;
}

async function latestRun(): Promise<AnyRecord | null> {
  const { data, error } = await db
    .from("ingestion_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? mapRunRow(data) : null;
}

async function runIngestion(reason: string): Promise<AnyRecord> {
  const runtime = await loadRuntimeSourceConfig();
  const sources = configuredSources(runtime.settings);
  const startedAt = new Date().toISOString();
  const reports: AnyRecord[] = [];
  let fetchedCount = 0;
  let upsertedCount = 0;
  let failedCount = 0;

  for (const source of sources) {
    const report = {
      id: source.id,
      name: source.name,
      enabled: source.enabled,
      fetched: 0,
      upserted: 0,
      failed: 0,
      error: "",
      startedAt: new Date().toISOString(),
      finishedAt: ""
    };
    if (!source.enabled) {
      report.finishedAt = new Date().toISOString();
      reports.push(report);
      continue;
    }
    try {
      const rawJobs = await source.fetchJobs();
      const jobs = normalizeMany(rawJobs);
      report.fetched = rawJobs.length;
      fetchedCount += rawJobs.length;
      report.upserted = await upsertJobs(jobs);
      upsertedCount += report.upserted;
      const sourceRowId = runtime.sourceIdByKey.get(source.id);
      if (sourceRowId) {
        await db.from("job_sources").update({ last_success_at: new Date().toISOString() }).eq("id", sourceRowId);
      }
    } catch (error) {
      report.error = formatError(error);
      report.failed += 1;
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

  const { error } = await db.from("ingestion_runs").insert({
    id: run.id,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    fetched_count: run.fetchedCount,
    upserted_count: run.upsertedCount,
    failed_count: run.failedCount,
    sources: run.sources
  });
  if (error) throw error;

  const sourceRunRows = reports
    .filter((report) => runtime.sourceIdByKey.has(report.id))
    .map((report) => ({
      ingestion_run_id: run.id,
      job_source_id: runtime.sourceIdByKey.get(report.id),
      source_key: report.id,
      fetched_count: report.fetched,
      upserted_count: report.upserted,
      failed_count: report.failed,
      error_text: report.error,
      started_at: report.startedAt,
      finished_at: report.finishedAt
    }));
  if (sourceRunRows.length) {
    const { error: reportError } = await db.from("source_run_reports").insert(sourceRunRows);
    if (reportError) throw reportError;
  }

  return { run, totalJobs: await countJobs() };
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

function uniqueJobsById(jobs: AnyRecord[]): AnyRecord[] {
  const map = new Map<string, AnyRecord>();
  jobs.forEach((job) => {
    if (job.id) map.set(job.id, job);
  });
  return [...map.values()];
}

function formatError(error: any): string {
  if (!error || typeof error !== "object") return String(error || "Unknown error");
  return [error.message, error.code, error.details, error.hint]
    .map((part) => clean(part))
    .filter(Boolean)
    .join(" | ") || "Unknown error";
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

async function runNotificationWorker(input: AnyRecord = {}): Promise<AnyRecord> {
  const hours = clamp(Number(input.hours || 48), 1, 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const recentJobs = await loadRecentJobs(since, clamp(Number(input.limit || 120), 1, 500));
  if (!recentJobs.length) return { checkedJobs: 0, checkedUsers: 0, created: 0, emailed: 0 };

  const [{ data: preferences, error: preferencesError }, { data: profiles, error: profilesError }, { data: settings, error: settingsError }, { data: cvs, error: cvsError }, { data: applications, error: applicationsError }] = await Promise.all([
    db.from("notification_preferences").select("*").or("in_app_enabled.eq.true,email_job_alerts.eq.true"),
    db.from("profiles").select("*").eq("account_status", "active"),
    db.from("user_settings").select("*"),
    db.from("cv_documents").select("*").eq("is_primary", true),
    db.from("applications").select("user_id,job_id,status")
  ]);
  if (preferencesError) throw preferencesError;
  if (profilesError) throw profilesError;
  if (settingsError) throw settingsError;
  if (cvsError) throw cvsError;
  if (applicationsError) throw applicationsError;

  const profileMap = new Map((profiles || []).map((row: AnyRecord) => [row.id, row]));
  const settingsMap = new Map((settings || []).map((row: AnyRecord) => [row.user_id, row]));
  const cvMap = new Map((cvs || []).map((row: AnyRecord) => [row.user_id, row]));
  const applicationsByUser = groupBy(applications || [], "user_id");
  let created = 0;
  let emailed = 0;

  for (const preference of preferences || []) {
    const userId = preference.user_id;
    if (!profileMap.has(userId)) continue;
    const cv = cvMap.get(userId);
    if (!cv?.cv_state) continue;
    const threshold = clamp(Number(settingsMap.get(userId)?.minimum_match_score || 70), 0, 100);
    const appliedJobIds = new Set((applicationsByUser.get(userId) || []).map((row: AnyRecord) => row.job_id));

    for (const job of recentJobs) {
      const match = scoreJob(cv.cv_state, job);
      const similar = appliedJobIds.has(job.id) || isSimilarToApplied(job, recentJobs.filter((item) => appliedJobIds.has(item.id)));
      const type = similar ? "new_job_similar_to_application" : "new_job_match";
      if (match.score < threshold && !similar) continue;
      if (preference.in_app_enabled === false && preference.email_job_alerts === false) continue;

      const notification = {
        user_id: userId,
        type,
        title: `${match.score}% fit`,
        body: `${job.title}${job.company ? ` at ${job.company}` : ""}${job.locationText ? `, ${job.locationText}` : ""}.`,
        action_url: `#jobs?job=${encodeURIComponent(job.id)}`,
        payload: { jobId: job.id, score: match.score, bucket: match.bucket, matched: match.matched, missing: match.missing }
      };
      const { data, error } = await db
        .from("notifications")
        .upsert(notification, { onConflict: "user_id,type,action_url", ignoreDuplicates: true })
        .select("*")
        .maybeSingle();
      if (error) throw error;
      if (!data) continue;
      created += 1;
      if (preference.email_job_alerts && preference.frequency === "immediate") {
        const sent = await sendNotificationEmail(profileMap.get(userId), data);
        if (sent) emailed += 1;
      }
    }
  }

  return { checkedJobs: recentJobs.length, checkedUsers: (preferences || []).length, created, emailed };
}

async function loadRecentJobs(since: string, limit: number): Promise<AnyRecord[]> {
  const { data, error } = await db
    .from("public_jobs_v")
    .select("*")
    .neq("status", "expired")
    .gte("first_seen_at", since)
    .order("first_seen_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(mapJobRow);
}

function groupBy(rows: AnyRecord[], key: string): Map<string, AnyRecord[]> {
  const map = new Map<string, AnyRecord[]>();
  rows.forEach((row) => {
    const value = clean(row[key]);
    if (!value) return;
    map.set(value, [...(map.get(value) || []), row]);
  });
  return map;
}

function isSimilarToApplied(job: AnyRecord, appliedJobs: AnyRecord[]): boolean {
  const text = `${job.title} ${job.company} ${job.category} ${job.locationText}`.toLowerCase();
  return appliedJobs.some((applied) => {
    const terms = [applied.title, applied.company, applied.category, applied.locationText]
      .map((item) => clean(item).toLowerCase())
      .filter((item) => item.length > 3);
    return terms.some((term) => text.includes(term));
  });
}

async function sendNotificationEmail(profile: AnyRecord | undefined, notification: AnyRecord): Promise<boolean> {
  const apiKey = Deno.env.get("RESEND_API_KEY") || "";
  const from = Deno.env.get("NOTIFICATION_FROM_EMAIL") || "";
  const to = clean(profile?.email);
  if (!apiKey || !from || !to) {
    await recordDelivery(notification.id, "email", "skipped", "", "Email provider is not configured.");
    return false;
  }
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
        subject: notification.title || "SearchR alert",
        html: `<p>${escapeHtmlText(notification.body)}</p><p><a href="https://searchr.co.za/${notification.action_url || ""}">Open SearchR</a></p>`
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
    await recordDelivery(notification.id, "email", "sent", clean(payload.id), "");
    return true;
  } catch (error) {
    await recordDelivery(notification.id, "email", "failed", "", formatError(error));
    return false;
  }
}

async function recordDelivery(notificationId: string, channel: string, status: string, providerMessageId: string, errorText: string): Promise<void> {
  const row = {
    notification_id: notificationId,
    channel,
    status,
    provider_message_id: providerMessageId,
    error_text: errorText,
    sent_at: status === "sent" ? new Date().toISOString() : null
  };
  const { error } = await db.from("notification_deliveries").insert(row);
  if (error) console.error(error);
}

function escapeHtmlText(value: string): string {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function mapJobRow(row: AnyRecord): AnyRecord {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    canonicalUrl: row.canonical_url,
    applyUrl: row.apply_url,
    title: row.title,
    company: row.company,
    descriptionText: row.description_text,
    locationText: row.location_text,
    workplaceType: row.workplace_type,
    employmentType: row.employment_type,
    salaryMin: row.salary_min === null ? null : Number(row.salary_min),
    salaryMax: row.salary_max === null ? null : Number(row.salary_max),
    salaryCurrency: row.salary_currency,
    postedAt: row.posted_at,
    expiresAt: row.expires_at,
    status: row.status,
    category: row.category,
    requirements: row.requirements || {},
    contentHash: row.content_hash,
    rawPayload: row.raw_payload || {},
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at
  };
}

function mapRunRow(row: AnyRecord): AnyRecord {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    fetchedCount: row.fetched_count,
    upsertedCount: row.upserted_count,
    failedCount: row.failed_count,
    sources: row.sources || []
  };
}

function mapApplicationRow(row: AnyRecord): AnyRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    kitId: row.kit_id,
    status: row.status,
    method: row.method,
    notes: row.notes,
    startedAt: row.started_at,
    submittedAt: row.submitted_at || "",
    externalApplicationId: row.external_application_id,
    events: row.events || []
  };
}

function listFromJson(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueList(value.map((item) => clean(item)).filter(Boolean));
  return uniqueList(String(value || "").split(",").map((item) => clean(item)).filter(Boolean));
}

function uniqueList(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
