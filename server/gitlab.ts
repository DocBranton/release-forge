// Minimal GitLab REST v4 client. The host comes from server config (GITLAB_URL), never from a request,
// so registering an application cannot point the server at an arbitrary URL.

export interface GlPipeline { id: number; sha: string; ref: string; status: string; source?: string; web_url?: string; created_at: string; updated_at?: string; tag?: boolean; user?: { username?: string } }
export interface GlJob { id: number; name: string; status: string; stage: string; artifacts_file?: { filename: string } | null; artifacts?: { file_type: string }[] }

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

export class GitLabError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export class GitLab {
  constructor(private baseUrl: string, private token: string, private fetchFn: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async req(path: string, raw = false): Promise<any> {
    const r = await this.fetchFn(`${this.baseUrl}/api/v4${path}`, {
      headers: { "PRIVATE-TOKEN": this.token, Accept: raw ? "*/*" : "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new GitLabError(`GitLab ${path.split("?")[0]} returned ${r.status}`, r.status);
    if (!raw) return r.json();
    const len = Number(r.headers.get("content-length") ?? 0);
    if (len > MAX_ARTIFACT_BYTES) throw new GitLabError(`artifact larger than ${MAX_ARTIFACT_BYTES} bytes`, 413);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_ARTIFACT_BYTES) throw new GitLabError(`artifact larger than ${MAX_ARTIFACT_BYTES} bytes`, 413);
    return buf.toString("utf8");
  }

  private p(project: string) { return encodeURIComponent(project); }

  /** Finished pipelines, newest first. */
  async pipelines(project: string, perPage = 20): Promise<GlPipeline[]> {
    return (await this.req(`/projects/${this.p(project)}/pipelines?scope=finished&order_by=id&sort=desc&per_page=${perPage}`)) ?? [];
  }
  async pipeline(project: string, id: number): Promise<GlPipeline | null> {
    return this.req(`/projects/${this.p(project)}/pipelines/${id}`);
  }
  async jobs(project: string, pipelineId: number): Promise<GlJob[]> {
    return (await this.req(`/projects/${this.p(project)}/pipelines/${pipelineId}/jobs?per_page=100`)) ?? [];
  }
  /** One file from a job's artifacts, or null when the job has no such file. */
  async artifact(project: string, jobId: number, path: string): Promise<string | null> {
    const enc = path.split("/").map(encodeURIComponent).join("/");
    return this.req(`/projects/${this.p(project)}/jobs/${jobId}/artifacts/${enc}`, true);
  }
}
