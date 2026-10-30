import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { SUBMISSION_LIMITS as L } from "@/lib/config";
import { parseDomains } from "@/lib/env";
import { makeSummary } from "@/lib/news/format";
import { CAPTCHA_ERROR } from "./turnstile";
import { checkPhoto, ImageRejected, PHOTO_SIZE_MESSAGE, PHOTO_TYPE_MESSAGE, processPhoto, sniffImage } from "./image";
import { clientIp, emailAllowed, emailDomain, hashIp } from "./identity";
import { decideLimits, DUPLICATE_MESSAGE, EMAIL_LIMIT_MESSAGE, IP_LIMIT_MESSAGE, isDuplicate, windowStart } from "./limits";
import { readSubmission, submissionSchema, type RawSubmission } from "./schema";
import {
  GENERIC_ERROR,
  submitStory,
  type NewSubmissionArticle,
  type NewSubmitter,
  type Sector,
  type SubmissionDeps,
  type SubmissionStore,
  type SubmitInput,
} from "./service";
import { cleanLine, cleanParagraphs, stripControl, submissionSlug, titleKey } from "./text";

const SECTORS: Sector[] = [
  { id: "d-ev", slug: "ev", name: "EV" },
  { id: "d-ai", slug: "ai-technology", name: "AI & Technology" },
  { id: "d-sw", slug: "software", name: "Software Development" },
];
const DOMAINS = ["adorpower.com"];
const STORY = "The charging team finished the pilot line this week. ".repeat(6).trim(); // ~300 chars

const valid = (over: Partial<RawSubmission> = {}): RawSubmission => ({
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@adorpower.com",
  authorDepartment: "Software Development",
  sector: "ai-technology",
  title: "Pilot line finished ahead of plan",
  text: STORY,
  country: "IN",
  photoCredit: "",
  ownWork: "on",
  noConfidential: "on",
  ...over,
});

const schema = (domains: string[] = DOMAINS) => submissionSchema({ allowedDomains: domains, sectors: SECTORS.map((s) => s.slug) });
const errorsOf = (raw: RawSubmission, domains?: string[]) => {
  const r = schema(domains).safeParse(raw);
  if (r.success) return {};
  return Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message]));
};

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------
describe("text cleaning", () => {
  it("strips control, zero-width and bidi characters but keeps normal text", () => {
    const dirty = `He${String.fromCharCode(0)}llo${String.fromCharCode(7)} wor${String.fromCharCode(0x200b)}ld${String.fromCharCode(0x202e)}!${String.fromCharCode(0xfeff)}`;
    expect(stripControl(dirty)).toBe("Hello world!");
    expect(cleanLine("  a\tb \n c  ")).toBe("a b c");
  });

  it("turns each line break into a paragraph, whatever the line ending", () => {
    expect(cleanParagraphs("One.\r\nTwo.\rThree.\n\n\n  Four.  ")).toBe("One.\n\nTwo.\n\nThree.\n\nFour.");
    expect(cleanParagraphs(`A${String.fromCharCode(0x2028)}B`)).toBe("A\n\nB");
  });

  it("leaves markup alone: it is stored as text and escaped on output", () => {
    expect(cleanParagraphs('<script>alert(1)</script> **bold** [x](http://y)')).toBe('<script>alert(1)</script> **bold** [x](http://y)');
  });

  it("builds a slug with an id suffix and compares titles loosely", () => {
    expect(submissionSlug("Pilot line: finished 100% early!", "abcdef12-3456")).toBe("pilot-line-finished-100-early-abcdef12");
    expect(submissionSlug("!!!", "abcdef12-3456")).toBe("story-abcdef12");
    expect(titleKey("  Hello   WORLD ")).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
describe("company email domain", () => {
  it("matches the whole domain only", () => {
    expect(emailAllowed("a@adorpower.com", DOMAINS)).toBe(true);
    expect(emailAllowed("A@AdorPower.COM", DOMAINS)).toBe(true);
    expect(emailAllowed("a@evil-adorpower.com", DOMAINS)).toBe(false);
    expect(emailAllowed("a@adorpower.com.evil.io", DOMAINS)).toBe(false);
    expect(emailAllowed("a@mail.adorpower.com", DOMAINS)).toBe(false);
    expect(emailAllowed("a@gmail.com", DOMAINS)).toBe(false);
    expect(emailDomain("x@y@adorpower.com")).toBe("adorpower.com");
  });

  it("allows any address when no domain is configured", () => {
    expect(emailAllowed("a@gmail.com", [])).toBe(true);
  });

  it("parses the ALLOWED_EMAIL_DOMAINS list and reports entries that are not domains", () => {
    expect(parseDomains("AdorPower.com, @example.org ,adorpower.com")).toEqual({ domains: ["adorpower.com", "example.org"], invalid: [] });
    expect(parseDomains("")).toEqual({ domains: [], invalid: [] });
    expect(parseDomains("adorpower,com")).toEqual({ domains: [], invalid: ["adorpower", "com"] });
  });
});

describe("IP handling", () => {
  it("takes the first forwarded address and ignores junk", () => {
    const h = (v: Record<string, string>) => ({ get: (n: string) => v[n.toLowerCase()] ?? null });
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(h({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(h({ "x-forwarded-for": "not-an-ip" }))).toBeNull();
    expect(clientIp(h({}))).toBeNull();
  });

  it("hashes with a secret: stable, not the raw IP, different per secret, and one hash per IPv6 /64", () => {
    const a = hashIp("203.0.113.7", "secret-secret-secret-1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203");
    expect(hashIp("203.0.113.7", "secret-secret-secret-1")).toBe(a);
    expect(hashIp("203.0.113.7", "another-secret-value-2")).not.toBe(a);
    expect(hashIp("203.0.113.8", "secret-secret-secret-1")).not.toBe(a);
    expect(hashIp("2001:db8:1:2:aaaa::1", "s")).toBe(hashIp("2001:db8:1:2:bbbb:cccc:dddd:1", "s"));
    expect(hashIp("2001:db8:1:3::1", "s")).not.toBe(hashIp("2001:db8:1:2::1", "s"));
  });
});

// ---------------------------------------------------------------------------
// Validation (zod, server side)
// ---------------------------------------------------------------------------
describe("submission validation", () => {
  it("accepts a complete submission and cleans it", () => {
    const r = schema().safeParse(valid({ firstName: "  Ada ", email: " ADA@AdorPower.com ", text: `${STORAGE_TEXT()}\n\nSecond paragraph.` }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.firstName).toBe("Ada");
      expect(r.data.email).toBe("ada@adorpower.com");
      expect(r.data.country).toBe("IN");
      expect(r.data.photoCredit).toBeNull();
      expect(r.data.ownWork).toBe(true);
    }
  });

  it("requires first and last name, within 60 characters", () => {
    expect(errorsOf(valid({ firstName: " " })).firstName).toBe("Enter your first name.");
    expect(errorsOf(valid({ lastName: "" })).lastName).toBe("Enter your last name.");
    expect(errorsOf(valid({ firstName: "a".repeat(61) })).firstName).toMatch(/at most 60/);
    expect(errorsOf(valid({ firstName: "a".repeat(60) })).firstName).toBeUndefined();
  });

  it("requires a company email on an allowed domain, in plain words", () => {
    expect(errorsOf(valid({ email: "" })).email).toBe("Enter your company email address.");
    expect(errorsOf(valid({ email: "ada" })).email).toBe("That does not look like an email address.");
    expect(errorsOf(valid({ email: "ada@gmail.com" })).email).toBe("Use your company email address (it must end with @adorpower.com).");
    expect(errorsOf(valid({ email: "ada@evil-adorpower.com" })).email).toMatch(/Use your company email/);
    expect(errorsOf(valid({ email: "ada@gmail.com" }), ["a.com", "b.org"]).email).toMatch(/@a\.com or @b\.org/);
  });

  it("accepts any well-formed email when no domain list is configured", () => {
    expect(errorsOf(valid({ email: "ada@gmail.com" }), []).email).toBeUndefined();
    expect(errorsOf(valid({ email: "not-an-email" }), []).email).toBe("That does not look like an email address.");
  });

  it("checks the title length: 5 to 140 characters", () => {
    expect(errorsOf(valid({ title: "four" })).title).toMatch(/at least 5/);
    expect(errorsOf(valid({ title: "fives" })).title).toBeUndefined();
    expect(errorsOf(valid({ title: "t".repeat(140) })).title).toBeUndefined();
    expect(errorsOf(valid({ title: "t".repeat(141) })).title).toMatch(/at most 140 characters \(it has 141\)/);
  });

  it("checks the story length: 200 to 6000 characters, counted after cleaning", () => {
    expect(errorsOf(valid({ text: "x".repeat(199) })).text).toMatch(/at least 200 characters \(it has 199\)/);
    expect(errorsOf(valid({ text: "x".repeat(200) })).text).toBeUndefined();
    expect(errorsOf(valid({ text: "x".repeat(6000) })).text).toBeUndefined();
    expect(errorsOf(valid({ text: "x".repeat(6001) })).text).toMatch(/at most 6000 characters/);
    // control characters do not count towards the minimum
    expect(errorsOf(valid({ text: `${"x".repeat(150)}${String.fromCharCode(0).repeat(100)}` })).text).toMatch(/at least 200/);
  });

  it("requires both confirmations", () => {
    expect(errorsOf(valid({ ownWork: "" })).ownWork).toMatch(/your own work/);
    expect(errorsOf(valid({ noConfidential: "" })).noConfidential).toMatch(/no confidential or customer information/);
    expect(errorsOf(valid({ ownWork: "yes" })).ownWork).toBeDefined(); // only a ticked box ("on") counts
  });

  it("only accepts listed departments, sectors and countries", () => {
    expect(errorsOf(valid({ authorDepartment: "Piracy" })).authorDepartment).toBeDefined();
    expect(errorsOf(valid({ authorDepartment: "" })).authorDepartment).toBeDefined();
    expect(errorsOf(valid({ authorDepartment: "Other" })).authorDepartment).toBeUndefined();
    expect(errorsOf(valid({ sector: "nope" })).sector).toBeDefined();
    expect(errorsOf(valid({ sector: "world" })).sector).toBeDefined(); // not offered: only company departments
    expect(errorsOf(valid({ country: "ZZ" })).country).toBeDefined();
  });

  it("treats the country as optional and normalises it", () => {
    const none = schema().safeParse(valid({ country: "" }));
    expect(none.success && none.data.country).toBeNull();
    const lower = schema().safeParse(valid({ country: "de" }));
    expect(lower.success && lower.data.country).toBe("DE");
  });

  it("limits the photo credit", () => {
    expect(errorsOf(valid({ photoCredit: "c".repeat(201) })).photoCredit).toMatch(/at most 200/);
    const ok = schema().safeParse(valid({ photoCredit: " Photo by me " }));
    expect(ok.success && ok.data.photoCredit).toBe("Photo by me");
  });

  it("reads only the known fields from a FormData, as strings", () => {
    const form = new FormData();
    form.set("firstName", "Ada");
    form.set("title", new File(["x"], "t.txt")); // a file in a text field is ignored
    form.set("isAdmin", "true"); // unknown fields are dropped
    const raw = readSubmission(form);
    expect(raw.firstName).toBe("Ada");
    expect(raw.title).toBe("");
    expect("isAdmin" in raw).toBe(false);
  });
});

function STORAGE_TEXT() {
  return STORY;
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
const solid = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } });

describe("photo checks (magic bytes)", () => {
  it("recognises JPEG, PNG and WebP by their first bytes", async () => {
    expect(sniffImage(await solid(8, 8).jpeg().toBuffer())).toBe("jpeg");
    expect(sniffImage(await solid(8, 8).png().toBuffer())).toBe("png");
    expect(sniffImage(await solid(8, 8).webp().toBuffer())).toBe("webp");
  });

  it("rejects other types, whatever they are called", async () => {
    for (const bytes of [
      Buffer.from("%PDF-1.7 not a picture"),
      Buffer.from("GIF89a....."),
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      Buffer.from("MZ\x90\x00 an executable renamed photo.jpg"),
      Buffer.from("<?php echo 1; ?>"),
      Buffer.alloc(0),
      Buffer.from([0xff, 0xd8]), // too short to be a JPEG
    ]) {
      expect(sniffImage(bytes)).toBeNull();
      expect(() => checkPhoto(bytes)).toThrow(PHOTO_TYPE_MESSAGE);
    }
    // "RIFF" alone (a WAV, an AVI) is not WebP
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]))).toBeNull();
  });

  it("rejects a file over 5 MB before looking at it, even if it starts like a JPEG", () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(L.PHOTO_MAX_BYTES)]);
    expect(() => checkPhoto(big)).toThrow(PHOTO_SIZE_MESSAGE);
    const exactly = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(L.PHOTO_MAX_BYTES - 3)]);
    expect(checkPhoto(exactly)).toBe("jpeg");
  });
});

describe("photo processing (sharp)", () => {
  it("strips EXIF and GPS data and converts to WebP", async () => {
    const withGps = await solid(64, 48)
      .jpeg()
      .withExif({ IFD0: { Copyright: "Secret Owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "0/1 7/1 0/1" } })
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined(); // the fixture really has metadata

    const out = await processPhoto(withGps);
    expect(out.contentType).toBe("image/webp");
    expect(sniffImage(out.data)).toBe("webp");
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(out.data.includes(Buffer.from("Secret Owner"))).toBe(false);
  });

  it("scales a wide photo down to 1600px and never enlarges a small one", async () => {
    const big = await processPhoto(await solid(3200, 1000).jpeg().toBuffer());
    expect(big.width).toBe(1600);
    expect(big.height).toBe(500);
    const small = await processPhoto(await solid(300, 200).png().toBuffer());
    expect(small.width).toBe(300);
  });

  it("turns a photo upright from its EXIF orientation before the metadata is dropped", async () => {
    const rotated = await solid(200, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer(); // stored sideways
    const out = await processPhoto(rotated);
    expect([out.width, out.height]).toEqual([100, 200]);
  });

  it("accepts a PNG and a WebP upload as well", async () => {
    expect((await processPhoto(await solid(20, 20).png().toBuffer())).contentType).toBe("image/webp");
    expect((await processPhoto(await solid(20, 20).webp().toBuffer())).contentType).toBe("image/webp");
  });

  it("rejects a corrupt file that only starts like a JPEG", async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("this is not image data at all")]);
    await expect(processPhoto(fake)).rejects.toBeInstanceOf(ImageRejected);
  });

  it("rejects a wrong type before decoding", async () => {
    await expect(processPhoto(Buffer.from("hello world, definitely text"))).rejects.toThrow(PHOTO_TYPE_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// Abuse limits (pure rules)
// ---------------------------------------------------------------------------
describe("limit rules", () => {
  const none = { ip: 0, email: 0 };
  it("allows up to 3 per IP and 5 per email a day, and refuses the next one", () => {
    expect(decideLimits({ counts: { ip: 2, email: 4 }, title: "T", recentTitles: [] })).toEqual({ ok: true });
    expect(decideLimits({ counts: { ip: 3, email: 0 }, title: "T", recentTitles: [] })).toEqual({ ok: false, reason: "ip", message: IP_LIMIT_MESSAGE });
    expect(decideLimits({ counts: { ip: 0, email: 5 }, title: "T", recentTitles: [] })).toEqual({ ok: false, reason: "email", message: EMAIL_LIMIT_MESSAGE });
  });

  it("skips the IP rule when the address is unknown", () => {
    expect(decideLimits({ counts: { ip: null, email: 0 }, title: "T", recentTitles: [] })).toEqual({ ok: true });
  });

  it("calls the same title a duplicate regardless of case and spacing", () => {
    expect(isDuplicate("Pilot  Line", ["pilot line"])).toBe(true);
    expect(isDuplicate("Pilot line 2", ["pilot line"])).toBe(false);
    expect(decideLimits({ counts: none, title: "Pilot line", recentTitles: ["PILOT LINE"] })).toEqual({ ok: false, reason: "duplicate", message: DUPLICATE_MESSAGE });
  });

  it("looks back 24 hours", () => {
    expect(windowStart(new Date("2026-10-15T12:00:00.000Z"))).toBe("2026-10-14T12:00:00.000Z");
  });

  it("explains each refusal in plain words", () => {
    expect(IP_LIMIT_MESSAGE).toMatch(/Too many stories/);
    expect(EMAIL_LIMIT_MESSAGE).toMatch(/already sent 5 stories today/);
    expect(DUPLICATE_MESSAGE).toMatch(/already sent a story with this title/);
  });
});

// ---------------------------------------------------------------------------
// The whole flow, with an in-memory store
// ---------------------------------------------------------------------------
type Row = { id: string; article: NewSubmissionArticle; submitter: NewSubmitter };

function setup(over: { domains?: string[]; failInsert?: boolean; processPhoto?: SubmissionDeps["processPhoto"] } = {}) {
  const clock = { now: new Date("2026-10-15T10:00:00.000Z") };
  const rows: Row[] = [];
  const photos = new Map<string, Buffer>();
  const removed: string[] = [];
  const store: SubmissionStore = {
    sectors: async () => SECTORS,
    counts: async ({ ipHash, email, sinceIso }) => ({
      ip: ipHash ? rows.filter((r) => r.submitter.ip_hash === ipHash && r.submitter.submitted_at >= sinceIso).length : null,
      email: rows.filter((r) => r.submitter.email === email && r.submitter.submitted_at >= sinceIso).length,
    }),
    recentTitles: async (email, sinceIso) => rows.filter((r) => r.submitter.email === email && r.submitter.submitted_at >= sinceIso).map((r) => r.article.headline),
    uploadPhoto: async (path, data) => void photos.set(path, data),
    removePhoto: async (path) => {
      removed.push(path);
      photos.delete(path);
    },
    insert: async (article, submitter) => {
      if (over.failInsert) throw new Error("db down");
      const id = `row-${rows.length + 1}`;
      rows.push({ id, article, submitter });
      return { id };
    },
  };
  let n = 0;
  const logError = vi.fn();
  const deps: SubmissionDeps = {
    store,
    allowedDomains: over.domains ?? DOMAINS,
    hashIp: (ip) => hashIp(ip, "test-secret-test-secret"),
    now: () => clock.now,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    processPhoto: over.processPhoto,
    logError,
  };
  const send = (input: Omit<Partial<SubmitInput>, "fields"> & { fields?: Partial<RawSubmission> } = {}) =>
    submitStory(deps, { honeypot: "", photo: null, ip: "203.0.113.7", ...input, fields: valid(input.fields) });
  return { deps, rows, photos, removed, clock, send, logError };
}

const photoOf = (bytes: Uint8Array) => ({ size: bytes.length, bytes: async () => bytes });

describe("submitStory", () => {
  it("stores a pending employee story, filed under the chosen sector, with the default image when there is no photo", async () => {
    const t = setup();
    expect(await t.send()).toEqual({ ok: true });
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].article).toMatchObject({
      headline: "Pilot line finished ahead of plan",
      body: STORY,
      status: "pending_review",
      origin: "employee",
      author_first_name: "Ada",
      author_last_name: "Lovelace",
      author_department: "Software Development",
      department_id: "d-ai",
      country_code: "IN",
      country_name: "India",
      source_urls: [],
      image_url: "/images/defaults/ai-technology.svg",
      image_credit: null,
    });
    expect(t.rows[0].article.slug).toMatch(/^pilot-line-finished-ahead-of-plan-[0-9a-f]{8}$/);
    expect(t.photos.size).toBe(0);
  });

  it("stores the card summary with the story, so the feed never needs the body (PERF-01)", async () => {
    const t = setup();
    await t.send();
    expect(t.rows[0].article.summary).toBe(makeSummary(STORY));
    expect(t.rows[0].article.summary.length).toBeLessThanOrEqual(241);
  });

  it("keeps the email, the IP hash and the flag out of the article row", async () => {
    const t = setup();
    await t.send();
    const { article, submitter } = t.rows[0];
    expect(JSON.stringify(article)).not.toContain("ada@adorpower.com");
    expect(Object.keys(article)).not.toEqual(expect.arrayContaining(["email"]));
    expect(submitter).toMatchObject({ email: "ada@adorpower.com", email_verified: true, image_path: null });
  });

  it("never stores the raw IP, only its keyed hash", async () => {
    const t = setup();
    await t.send({ ip: "203.0.113.7" });
    const json = JSON.stringify(t.rows);
    expect(json).not.toContain("203.0.113.7");
    expect(t.rows[0].submitter.ip_hash).toBe(hashIp("203.0.113.7", "test-secret-test-secret"));
  });

  it("flags the email as unverified when no domain list is configured, and accepts any address", async () => {
    const t = setup({ domains: [] });
    expect(await t.send({ fields: { email: "ada@gmail.com" } })).toEqual({ ok: true });
    expect(t.rows[0].submitter.email_verified).toBe(false);
  });

  it("refuses an address outside the company domain", async () => {
    const t = setup();
    const r = await t.send({ fields: { email: "ada@gmail.com" } });
    expect(r).toMatchObject({ ok: false, fieldErrors: { email: expect.stringContaining("company email") } });
    expect(t.rows).toHaveLength(0);
  });

  it("reports every problem at once and stores nothing", async () => {
    const t = setup();
    const r = await t.send({ fields: { firstName: "", title: "no", text: "short", ownWork: "", noConfidential: "" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors ?? {}).sort()).toEqual(["firstName", "noConfidential", "ownWork", "text", "title"]);
    expect(t.rows).toHaveLength(0);
  });

  it("ignores a submission whose hidden honeypot field is filled: reports success, stores nothing, checks nothing", async () => {
    const t = setup();
    const counts = vi.spyOn(t.deps.store, "counts");
    expect(await t.send({ honeypot: "http://spam.example" })).toEqual({ ok: true });
    expect(t.rows).toHaveLength(0);
    expect(counts).not.toHaveBeenCalled();
    // even an invalid form is silently dropped
    expect(await t.send({ honeypot: "x", fields: { firstName: "" } })).toEqual({ ok: true });
  });

  it("allows 3 submissions per IP a day and refuses the 4th, whatever the email", async () => {
    const t = setup();
    for (const i of [1, 2, 3]) expect(await t.send({ fields: { email: `user${i}@adorpower.com`, title: `Story number ${i}` } })).toEqual({ ok: true });
    const fourth = await t.send({ fields: { email: "user4@adorpower.com", title: "Story number 4" } });
    expect(fourth).toEqual({ ok: false, error: IP_LIMIT_MESSAGE });
    expect(t.rows).toHaveLength(3);
    // a different connection is fine
    expect(await t.send({ ip: "203.0.113.99", fields: { email: "user4@adorpower.com", title: "Story number 4" } })).toEqual({ ok: true });
  });

  it("allows 5 per email a day and refuses the 6th, from different connections", async () => {
    const t = setup();
    for (const i of [1, 2, 3, 4, 5]) {
      expect(await t.send({ ip: `198.51.100.${i}`, fields: { title: `Story number ${i}` } })).toEqual({ ok: true });
    }
    expect(await t.send({ ip: "198.51.100.6", fields: { title: "Story number 6" } })).toEqual({ ok: false, error: EMAIL_LIMIT_MESSAGE });
  });

  it("frees the limits again after 24 hours", async () => {
    const t = setup();
    for (const i of [1, 2, 3]) await t.send({ fields: { title: `Story number ${i}` } });
    expect((await t.send({ fields: { title: "Story number 4" } })).ok).toBe(false);
    t.clock.now = new Date(t.clock.now.getTime() + 24 * 3_600_000 + 1000);
    expect(await t.send({ fields: { title: "Story number 4" } })).toEqual({ ok: true });
  });

  it("refuses the same email with the same title within 24 hours, but not another email or a later day", async () => {
    const t = setup();
    expect(await t.send()).toEqual({ ok: true });
    expect(await t.send({ fields: { title: "  PILOT line finished AHEAD of plan " } })).toEqual({ ok: false, error: DUPLICATE_MESSAGE });
    expect(await t.send({ ip: "198.51.100.1", fields: { email: "bo@adorpower.com" } })).toEqual({ ok: true }); // other author, same title
    t.clock.now = new Date(t.clock.now.getTime() + 25 * 3_600_000);
    expect(await t.send({ ip: "198.51.100.2" })).toEqual({ ok: true });
  });

  it("applies only the email rule when the address is unknown", async () => {
    const t = setup();
    for (const i of [1, 2, 3, 4]) expect(await t.send({ ip: null, fields: { email: `u${i}@adorpower.com`, title: `Story number ${i}` } })).toEqual({ ok: true });
    expect(t.rows.every((r) => r.submitter.ip_hash === null)).toBe(true);
  });

  it("stores a valid photo (re-encoded) in the private bucket under a random name, and records it", async () => {
    const t = setup();
    const jpeg = await solid(640, 360).jpeg().toBuffer();
    expect(await t.send({ photo: photoOf(jpeg), fields: { photoCredit: "Photo by Ada" } })).toEqual({ ok: true });
    const { article, submitter } = t.rows[0];
    expect(submitter.image_path).toMatch(/^[0-9a-f-]{36}\.webp$/);
    expect(submitter.image_path).not.toContain("jpg");
    expect([...t.photos.keys()]).toEqual([submitter.image_path]);
    expect(sniffImage(t.photos.get(submitter.image_path!)!)).toBe("webp");
    // the public row has no photo URL yet: the admin approves first, and the photo is copied then
    expect(article.image_url).toBeNull();
    expect(article.image_credit).toBe("Photo by Ada");
  });

  it.each([
    ["a text file with a .jpg name", Buffer.from("just some text pretending to be a photo")],
    ["a PDF", Buffer.from("%PDF-1.4 ....")],
    ["an SVG", Buffer.from("<svg onload=alert(1)></svg>")],
  ])("rejects %s without storing anything", async (_name, bytes) => {
    const t = setup();
    const r = await t.send({ photo: photoOf(bytes) });
    expect(r).toMatchObject({ ok: false, fieldErrors: { photo: PHOTO_TYPE_MESSAGE } });
    expect(t.rows).toHaveLength(0);
    expect(t.photos.size).toBe(0);
  });

  it("rejects an oversize photo from its declared size, without reading it", async () => {
    const t = setup();
    const bytes = vi.fn(async () => new Uint8Array(1));
    const r = await t.send({ photo: { size: L.PHOTO_MAX_BYTES + 1, bytes } });
    expect(r).toMatchObject({ ok: false, fieldErrors: { photo: PHOTO_SIZE_MESSAGE } });
    expect(bytes).not.toHaveBeenCalled();
  });

  it("treats an empty file chooser as no photo", async () => {
    const t = setup();
    expect(await t.send({ photo: { size: 0, bytes: async () => new Uint8Array() } })).toEqual({ ok: true });
    expect(t.photos.size).toBe(0);
  });

  it("does the expensive photo work only after the limits pass", async () => {
    const processPhoto = vi.fn(async () => ({ data: Buffer.from("x"), width: 1, height: 1, contentType: "image/webp" as const }));
    const t = setup({ processPhoto });
    await t.send();
    await t.send({ fields: { title: "Second story here" } });
    await t.send({ fields: { title: "Third story here" } });
    const jpeg = await solid(8, 8).jpeg().toBuffer();
    const refused = await t.send({ fields: { title: "Fourth story here" }, photo: photoOf(jpeg) });
    expect(refused.ok).toBe(false);
    expect(processPhoto).not.toHaveBeenCalled();
  });

  it("removes the uploaded photo and answers plainly when saving fails", async () => {
    const t = setup({ failInsert: true });
    const jpeg = await solid(64, 64).jpeg().toBuffer();
    const r = await t.send({ photo: photoOf(jpeg) });
    expect(r).toEqual({ ok: false, error: GENERIC_ERROR });
    expect(t.removed).toHaveLength(1);
    expect(t.photos.size).toBe(0);
    expect(t.logError).toHaveBeenCalledWith(expect.stringContaining("db down"));
  });

  it("allows no country, and keeps the story off the globe", async () => {
    const t = setup();
    await t.send({ fields: { country: "" } });
    expect(t.rows[0].article).toMatchObject({ country_code: null, country_name: null, place: null });
  });

  it("stores control characters out and keeps the text as plain paragraphs", async () => {
    const t = setup();
    await t.send({ fields: { text: `${STORY}\r\n<b>second</b> paragraph${String.fromCharCode(0)}` } });
    expect(t.rows[0].article.body).toBe(`${STORY}\n\n<b>second</b> paragraph`);
  });
});

describe("optional Turnstile check (off unless configured)", () => {
  it("is off when no captcha dependency is given: nothing changes", async () => {
    const t = setup();
    expect(await t.send()).toEqual({ ok: true });
    expect(t.rows).toHaveLength(1);
  });

  it("with the check on, a missing token stores nothing and asks the visitor to try again", async () => {
    const t = setup();
    const captcha = vi.fn(async (token: string | null) => token === "good-token");
    t.deps.captcha = captcha;
    const r = await t.send();
    expect(r).toEqual({ ok: false, error: CAPTCHA_ERROR });
    expect(t.rows).toHaveLength(0);
    expect(captcha).toHaveBeenCalledWith(null, "203.0.113.7");
  });

  it("with the check on, a wrong token stores nothing, a good one stores the story", async () => {
    const t = setup();
    t.deps.captcha = async (token) => token === "good-token";
    expect(await t.send({ captchaToken: "bad-token" })).toEqual({ ok: false, error: CAPTCHA_ERROR });
    expect(t.rows).toHaveLength(0);
    expect(await t.send({ captchaToken: "good-token" })).toEqual({ ok: true });
    expect(t.rows).toHaveLength(1);
  });

  it("runs before any store access: a failed check costs no database query", async () => {
    const t = setup();
    const sectors = vi.spyOn(t.deps.store, "sectors");
    t.deps.captcha = async () => false;
    await t.send({ captchaToken: "x" });
    expect(sectors).not.toHaveBeenCalled();
  });

  it("the honeypot still wins: a bot is told it worked and the check is not even asked", async () => {
    const t = setup();
    const captcha = vi.fn(async () => false);
    t.deps.captcha = captcha;
    expect(await t.send({ honeypot: "http://spam.example" })).toEqual({ ok: true });
    expect(captcha).not.toHaveBeenCalled();
    expect(t.rows).toHaveLength(0);
  });
});