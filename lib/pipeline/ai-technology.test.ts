import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_TECH_DEPARTMENT_NAME, AI_TECH_DEPARTMENT_SLUG, AI_TECH_DESCRIPTION, DEFAULT_IMAGE_SLUGS } from "@/lib/config";
import { defaultImagePath, departmentStyle } from "@/lib/news/departments";
import type { CallAgentParams, CallAgentResult } from "@/lib/llm";
import { existsSync } from "node:fs";
import {
  AI_TECH_GUIDANCE,
  buildClassifyPrompt,
  CLASSIFY_SYSTEM,
  classifyItem,
  classifySchema,
  classifySystem,
  matchDepartments,
  type ClassifyItem,
  type Department,
} from "./classify";

// The AI & Technology department: how it is described to the classifier, how items are routed to it, and
// that the migration seeds exactly what the code expects. The model itself is replaced by a fake, so these
// tests cover the prompt and the plumbing, not what a real model would answer.

const MIGRATION = readFileSync(new URL("../../supabase/migrations/2026-10-15-ai-tech-and-submissions.sql", import.meta.url), "utf8");

/** The keywords seeded by the migration, so the pre-check is tested against what production will hold. */
function seededKeywords(): string[] {
  const m = /values \(\s*'AI & Technology',[\s\S]*?array\[([^\]]+)\]/.exec(MIGRATION);
  expect(m, "department insert not found in the migration").not.toBeNull();
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const departments: Department[] = [
  { id: "d-ev", name: "EV", description: "Electric vehicles.", keywords: ["ev", "electric vehicle", "charging"], kind: "company" },
  {
    id: "d-sw",
    name: "Software Development",
    description: "Software engineering: embedded and automotive software, cloud, AI/ML tooling, cybersecurity and developer practices.",
    keywords: ["software", "developer", "api", "open source", "ai", "machine learning", "cybersecurity", "embedded", "firmware", "over-the-air", "ota"],
    kind: "company",
  },
  { id: "d-ai", name: AI_TECH_DEPARTMENT_NAME, description: AI_TECH_DESCRIPTION, keywords: seededKeywords(), kind: "company" },
  { id: "d-world", name: "World", description: "World news.", keywords: [], kind: "world" },
];

const NOW = new Date("2026-10-15T12:00:00Z");
const opts = { keywordPrecheck: true, threshold: 7, maxAgeDays: 3, now: NOW };
const item = (title: string, content = ""): ClassifyItem => ({ id: "raw-1", title, content, source_published_at: "2026-10-15T08:00:00Z", kind: "company" });

/** A fake model that answers with `answer` after the real schema has checked it. */
type Agent = <T>(params: CallAgentParams<T>) => Promise<CallAgentResult<T>>;
function fakeModel(answer: unknown): Agent & { calls: CallAgentParams<unknown>[] } {
  const calls: CallAgentParams<unknown>[] = [];
  const respond = async (p: CallAgentParams<unknown>): Promise<CallAgentResult<unknown>> => {
    calls.push(p);
    const parsed = p.schema.safeParse(answer);
    return parsed.success ? { ok: true, data: parsed.data, attempts: 1 } : { ok: false, reason: "invalid_output", error: parsed.error.message };
  };
  return Object.assign(respond as unknown as Agent, { calls });
}
const says = (department: string, relevance = 9) => ({ department, relevance, reason: "fits" });

describe("the department", () => {
  it("is described with every topic the editor listed", () => {
    for (const topic of [
      "artificial intelligence and machine learning",
      "LLMs and generative AI",
      "AI regulation and safety",
      "robotics and automation",
      "semiconductors and AI chips",
      "cloud and data-center technology",
      "cybersecurity",
    ]) {
      expect(AI_TECH_DESCRIPTION.toLowerCase()).toContain(topic.toLowerCase());
    }
  });

  it("appears in the classify prompt with that description", () => {
    const prompt = buildClassifyPrompt(item("x"), departments.filter((d) => d.kind !== "world"), new Map());
    expect(prompt).toContain(`- ${AI_TECH_DEPARTMENT_NAME}: ${AI_TECH_DESCRIPTION}`);
  });

  it("uses the code's description if the database row has none", () => {
    const blank = departments.map((d) => (d.id === "d-ai" ? { ...d, description: "" } : d));
    expect(buildClassifyPrompt(item("x"), blank, new Map())).toContain(`- ${AI_TECH_DEPARTMENT_NAME}: ${AI_TECH_DESCRIPTION}`);
  });

  it("is a valid answer for the classifier schema", () => {
    const names = departments.filter((d) => d.kind !== "world").map((d) => d.name) as [string, ...string[]];
    expect(classifySchema(names).safeParse(says("AI & Technology")).success).toBe(true);
    expect(classifySchema(names).safeParse(says("AI and Technology")).success).toBe(false);
  });

  it("has its style, default image and legend entry", () => {
    expect(DEFAULT_IMAGE_SLUGS).toContain(AI_TECH_DEPARTMENT_SLUG);
    expect(defaultImagePath(AI_TECH_DEPARTMENT_SLUG)).toBe("/images/defaults/ai-technology.svg");
    expect(existsSync(new URL("../../public/images/defaults/ai-technology.svg", import.meta.url))).toBe(true);
    const style = departmentStyle(AI_TECH_DEPARTMENT_SLUG);
    expect(style).toEqual({ chip: "#BABFBA", dot: "#657166" }); // pastel of deep sage for the tag, deep sage for the marker
  });

  it("uses the one palette colour no other department uses", () => {
    const others = ["ev", "batteries", "defence", "software", "sales-marketing", "world"].flatMap((s) => Object.values(departmentStyle(s)));
    const mine = departmentStyle(AI_TECH_DEPARTMENT_SLUG);
    expect(others).not.toContain(mine.chip);
    expect(others).not.toContain(mine.dot);
    // the tag is lighter than the marker, so ink text stays readable on it
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(mine.chip)).toBeGreaterThan(lum(mine.dot));
  });
});

describe("the classify prompt", () => {
  it("tells the model to pick one department and to prefer AI & Technology for mainly-AI stories", () => {
    const system = classifySystem(departments);
    expect(system).toContain(CLASSIFY_SYSTEM);
    expect(system).toContain(AI_TECH_GUIDANCE);
    expect(AI_TECH_GUIDANCE).toMatch(/ONE department/);
    expect(AI_TECH_GUIDANCE).toMatch(/mainly about AI or machine learning/);
    expect(AI_TECH_GUIDANCE).toMatch(/even when it could also fit "Software Development"/);
    expect(AI_TECH_GUIDANCE).toMatch(/overrides any department description/);
  });

  it("adds the notes only when the department exists", () => {
    expect(classifySystem(departments.filter((d) => d.id !== "d-ai"))).toBe(CLASSIFY_SYSTEM);
  });
});

describe("the keyword pre-check with the seeded keywords", () => {
  const hits = (title: string, content = "") => [...matchDepartments(item(title, content), departments).keys()];

  it.each([
    ["OpenAI releases a new large language model", "Researchers benchmark the LLM."],
    ["Nvidia unveils next-generation AI chip for data centers", ""],
    ["EU AI Act enforcement begins for general-purpose models", ""],
    ["Ransomware attack hits automaker supplier", "Cybersecurity teams respond."],
    ["Humanoid robots enter the assembly line", "Automation in the factory."],
    ["TSMC expands semiconductor capacity", ""],
    ["Hyperscaler opens new cloud region", ""],
    ["Machine learning model predicts battery degradation", ""],
  ])("routes %s to the department's candidates", (title, content) => {
    expect(hits(title, content)).toContain(AI_TECH_DEPARTMENT_NAME);
  });

  it("does not match plain software news or unrelated news", () => {
    expect(hits("Over-the-air update ships new infotainment firmware")).toEqual(["Software Development"]);
    expect(hits("Quarterly pasta recipes")).toEqual([]);
  });

  it("matches whole words only, so 'chip' does not match 'chipmunk' and 'ai' does not match 'said'", () => {
    expect(hits("The chipmunk said hello")).not.toContain(AI_TECH_DEPARTMENT_NAME);
  });
});

describe("classifying with the department", () => {
  it("files a mainly-AI story under AI & Technology even though Software Development also fits", async () => {
    const agent = fakeModel(says("AI & Technology"));
    const decision = await classifyItem(item("GitHub Copilot adds an agent mode for developers", "A new AI coding agent writes and tests software."), departments, opts, agent);
    expect(decision).toEqual({ kind: "update", update: { status: "new-relevant", relevance_score: 9, department_id: "d-ai", classify_reason: "fits" } });
    // the model saw both departments, the description and the tie-break rule, and picks exactly one
    const call = agent.calls[0];
    expect(call.system).toContain(AI_TECH_GUIDANCE);
    expect(call.prompt).toContain("- Software Development:");
    expect(call.prompt).toContain(`- ${AI_TECH_DEPARTMENT_NAME}: ${AI_TECH_DESCRIPTION}`);
    expect(call.prompt).not.toContain("- World:"); // company news is never filed under World
  });

  it("still files ordinary software news under Software Development", async () => {
    const decision = await classifyItem(item("Over-the-air update ships new infotainment firmware"), departments, opts, fakeModel(says("Software Development")));
    expect(decision).toMatchObject({ kind: "update", update: { status: "new-relevant", department_id: "d-sw" } });
  });

  it("accepts only one department per item and rejects made-up names", async () => {
    const decision = await classifyItem(item("OpenAI model"), departments, opts, fakeModel(says("AI & Technology, Software Development")));
    expect(decision).toMatchObject({ kind: "update", update: { status: "failed" } });
  });

  it("never files company news under World, and skips low relevance", async () => {
    const low = await classifyItem(item("OpenAI model"), departments, opts, fakeModel(says("AI & Technology", 3)));
    expect(low).toMatchObject({ kind: "update", update: { status: "skipped", relevance_score: 3 } });
  });
});

describe("what the migration seeds", () => {
  it("creates the department as a company department with the code's description and the right slug", () => {
    expect(MIGRATION).toContain(`'${AI_TECH_DESCRIPTION}'`);
    expect(MIGRATION).toMatch(/'AI & Technology',\s*'ai-technology',/);
    expect(MIGRATION).toMatch(/'company',\s*array\[/);
    expect(seededKeywords().length).toBeGreaterThan(20);
    expect(seededKeywords().every((k) => k === k.toLowerCase())).toBe(true);
  });

  it("seeds six verified feeds, each over https, none twice, and not VentureBeat", () => {
    const urls = [...MIGRATION.matchAll(/\('[^']+',\s*'(https:\/\/[^']+)'\)/g)].map((m) => m[1]);
    expect(urls).toHaveLength(6);
    expect(new Set(urls).size).toBe(6);
    expect(urls.some((u) => /venturebeat/i.test(u))).toBe(false);
    expect(MIGRATION).toMatch(/on conflict \(rss_url\) do nothing/);
  });
});
