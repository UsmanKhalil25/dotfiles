export interface PlanStep {
  step: number;
  text: string;
  completed?: boolean;
}

export interface PlanRecord {
  id: string;
  title: string;
  file: string;
  revision: number;
  status: "draft" | "revised" | "ready" | "approved" | "in_progress" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  executionStartedAt?: string;
  executionCompletedAt?: string;
  executionModel?: string;
  executionRunId?: string;
  executionAsyncDir?: string;
  sourceSession?: string;
  supersedes?: string;
  steps: PlanStep[];
}

export interface PlanIndex {
  version: 1;
  activePlanId?: string;
  records: PlanRecord[];
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "plan";
}

export function planTitle(markdown: string): string {
  const heading = markdown.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading.replace(/[`*_]/g, "");
  const firstLine = markdown.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  return (firstLine || "Implementation plan").replace(/[`*_]/g, "").slice(0, 120);
}

export function utcStamp(date = new Date()): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function planBaseId(date: Date, title: string): string {
  return `${utcStamp(date)}-${slugify(title)}`;
}

export function yamlValue(value: string | number | undefined): string {
  if (value === undefined || value === "") return "";
  return JSON.stringify(value);
}

export function renderPlanArtifact(record: PlanRecord, markdown: string): string {
  const steps = record.steps.map((step) => `${step.completed ? "- [x]" : "- [ ]"} ${step.step}. ${step.text}`).join("\n");
  const frontmatter = [
    "---",
    `id: ${yamlValue(record.id)}`,
    `title: ${yamlValue(record.title)}`,
    `status: ${yamlValue(record.status)}`,
    `revision: ${record.revision}`,
    `created_at: ${yamlValue(record.createdAt)}`,
    `updated_at: ${yamlValue(record.updatedAt)}`,
    `approved_at: ${yamlValue(record.approvedAt)}`,
    `execution_started_at: ${yamlValue(record.executionStartedAt)}`,
    `execution_completed_at: ${yamlValue(record.executionCompletedAt)}`,
    `execution_model: ${yamlValue(record.executionModel)}`,
    `execution_run_id: ${yamlValue(record.executionRunId)}`,
    `execution_async_dir: ${yamlValue(record.executionAsyncDir)}`,
    `source_session: ${yamlValue(record.sourceSession)}`,
    `supersedes: ${yamlValue(record.supersedes)}`,
    "---",
    "",
  ].join("\n");
  const body = markdown.trim();
  const stepSection = steps ? `\n\n## Tracked steps\n\n${steps}\n` : "";
  return `${frontmatter}${body}${stepSection}\n`;
}

export function parseFrontmatter(markdown: string): Record<string, string> {
  if (!markdown.startsWith("---\n")) return {};
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (const line of markdown.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string" || typeof parsed === "number") value = String(parsed);
    } catch {
      value = value.replace(/^['"]|['"]$/g, "");
    }
    result[match[1]] = value;
  }
  return result;
}

export function executionMarker(text: string): "completed" | "failed" | undefined {
  const match = text.match(/\[PLAN_EXECUTION_STATUS:\s*(completed|failed)\]/i);
  return match?.[1].toLowerCase() as "completed" | "failed" | undefined;
}
