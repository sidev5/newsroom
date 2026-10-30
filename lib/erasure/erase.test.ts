import { describe, expect, it, vi } from "vitest";
import { PUBLIC_IMAGE_PATH } from "@/lib/news/format";
import { ERASE_CONFIRM_WORD, eraseData, planErasure, publicPhotoPath, subjectHash, type ArticlePatch, type EraseDeps, type EraseLogEntry, type EraseStore, type PersonArticle } from "./erase";

// SEC-13: "Delete a person's data".

const EMAIL = "ada.lovelace@adorpower.com";
const SECRET = "test-secret-0123456789abcdef";
const PUBLIC_URL = `https://abc.supabase.co${PUBLIC_IMAGE_PATH}1111-2222.webp`;

const article = (over: Partial<PersonArticle> = {}): PersonArticle => ({
  id: "a1",
  headline: "Pilot line finished",
  status: "published",
  origin: "employee",
  image_url: "/images/defaults/ev.svg",
  image_path: null,
  departmentSlug: "ev",
  submittedAt: "2026-09-01T09:00:00Z",
  ...over,
});

function setup(o: { admin?: string | null; articles?: PersonArticle[]; recipients?: string[]; reader?: { likes: number; comments: number }; privateFail?: number; publicFail?: number; logFails?: boolean } = {}) {
  const calls: string[] = [];
  const updates: { id: string; patch: ArticlePatch }[] = [];
  const logs: EraseLogEntry[] = [];
  const removed: { bucket: string; paths: string[] }[] = [];
  const store: EraseStore = {
    submissionsOf: vi.fn(async (email) => {
      calls.push(`submissionsOf ${email}`);
      return o.articles ?? [];
    }),
    recipientsOf: vi.fn(async () => o.recipients ?? []),
    readerDataOf: vi.fn(async () => o.reader ?? { likes: 0, comments: 0 }),
    deleteReaderData: vi.fn(async () => {
      calls.push("deleteReaderData");
      return o.reader ?? { likes: 0, comments: 0 };
    }),
    removePhotos: vi.fn(async (bucket, paths) => {
      calls.push(`removePhotos ${bucket}`);
      removed.push({ bucket, paths });
      return { failed: bucket === "private" ? (o.privateFail ?? 0) : (o.publicFail ?? 0) };
    }),
    updateArticle: vi.fn(async (id, patch) => {
      calls.push(`updateArticle ${id}`);
      updates.push({ id, patch });
    }),
    deleteRecipients: vi.fn(async (ids) => {
      calls.push("deleteRecipients");
      return ids.length;
    }),
    deleteSubmitters: vi.fn(async (ids) => {
      calls.push("deleteSubmitters");
      return ids.length;
    }),
    log: vi.fn(async (entry) => {
      calls.push("log");
      if (o.logFails) throw new Error("log table missing");
      logs.push(entry);
    }),
  };
  const deps: EraseDeps = { store, adminEmail: async () => (o.admin === undefined ? "editor@adorpower.com" : o.admin), secret: SECRET, defaultImage: (slug) => `/images/defaults/${slug ?? "default"}.svg` };
  return { deps, store, calls, updates, logs, removed };
}

describe("subjectHash", () => {
  it("is a 64-character hex string that does not contain the address", () => {
    const h = subjectHash(EMAIL, SECRET);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("ada");
  });

  it("is the same for the same person however the address is typed, and differs per person and per key", () => {
    expect(subjectHash("  ADA.Lovelace@AdorPower.com ", SECRET)).toBe(subjectHash(EMAIL, SECRET));
    expect(subjectHash("someone.else@adorpower.com", SECRET)).not.toBe(subjectHash(EMAIL, SECRET));
    expect(subjectHash(EMAIL, "another-secret-0123456789")).not.toBe(subjectHash(EMAIL, SECRET));
  });
});

describe("publicPhotoPath", () => {
  it("is the file name inside the public bucket", () => {
    expect(publicPhotoPath(PUBLIC_URL)).toBe("1111-2222.webp");
  });

  it("is null for default images, other hosts' paths, and nonsense", () => {
    for (const v of ["/images/defaults/ev.svg", "https://images.unsplash.com/photo-1", `https://abc.supabase.co${PUBLIC_IMAGE_PATH}`, "https://abc.supabase.co/storage/v1/object/public/other/x.webp", "not a url", "", null]) {
      expect(publicPhotoPath(v)).toBeNull();
    }
  });
});

describe("planErasure", () => {
  it("is for admins only and reads nothing otherwise", async () => {
    const t = setup({ admin: null });
    expect(await planErasure(t.deps, EMAIL)).toEqual({ ok: false, error: "Not authorised." });
    expect(t.store.submissionsOf).not.toHaveBeenCalled();
  });

  it("asks for a full email address", async () => {
    const t = setup();
    for (const bad of ["", "ada", "ada@", "@adorpower.com", "a b@c.com", "x".repeat(300) + "@a.com"]) {
      expect(await planErasure(t.deps, bad), bad).toEqual({ ok: false, error: "Enter the person's full email address." });
    }
    expect(t.store.submissionsOf).not.toHaveBeenCalled();
  });

  it("looks the address up normalized (lower case, trimmed)", async () => {
    const t = setup();
    await planErasure(t.deps, "  Ada.Lovelace@AdorPower.com ");
    expect(t.calls[0]).toBe(`submissionsOf ${EMAIL}`);
  });

  it("lists their stories, their photos in both buckets and their digest subscription", async () => {
    const t = setup({
      articles: [article({ id: "a1", image_path: "p1.webp" }), article({ id: "a2", status: "pending_review", image_url: PUBLIC_URL, image_path: "p2.webp" })],
      recipients: ["r1"],
    });
    const r = await planErasure(t.deps, EMAIL);
    if (!r.ok) throw new Error("expected a plan");
    expect(r.plan).toMatchObject({ submitterRows: 2, privatePhotos: ["p1.webp", "p2.webp"], publicPhotos: ["1111-2222.webp"], recipientIds: ["r1"], readerLikes: 0, readerComments: 0, empty: false });
    expect(r.plan.articles.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(r.plan.subjectHash).toBe(subjectHash(EMAIL, SECRET));
  });

  it("says when nothing is stored, and changes nothing", async () => {
    const t = setup();
    const r = await planErasure(t.deps, EMAIL);
    expect(r).toMatchObject({ ok: true, plan: { empty: true, submitterRows: 0 } });
    expect(t.store.updateArticle).not.toHaveBeenCalled();
  });
});

describe("eraseData", () => {
  const stored = () => ({ articles: [article({ id: "a1", image_url: PUBLIC_URL, image_path: "p1.webp" }), article({ id: "a2", status: "pending_review", headline: "Second" })], recipients: ["r1"] });

  it("is for admins only and does nothing otherwise", async () => {
    const t = setup({ admin: null, ...stored() });
    expect(await eraseData(t.deps, EMAIL, "anonymize", ERASE_CONFIRM_WORD)).toEqual({ ok: false, error: "Not authorised." });
    expect(t.calls).toEqual([]);
  });

  it("needs a mode and the confirmation word, and does nothing without them", async () => {
    const t = setup(stored());
    expect(await eraseData(t.deps, EMAIL, "delete-everything", ERASE_CONFIRM_WORD)).toMatchObject({ ok: false, error: "Choose what happens to their stories." });
    expect(await eraseData(t.deps, EMAIL, "anonymize", "")).toMatchObject({ ok: false, error: "Type DELETE to confirm." });
    expect(await eraseData(t.deps, EMAIL, "anonymize", "delete")).toMatchObject({ ok: false });
    expect(await eraseData(t.deps, EMAIL, "anonymize", undefined)).toMatchObject({ ok: false });
    expect(t.calls).toEqual([]);
    expect(await eraseData(t.deps, EMAIL, "anonymize", ` ${ERASE_CONFIRM_WORD} `)).toMatchObject({ ok: true });
  });

  it("anonymize: removes the byline, the credit and the photos, keeps the stories published, deletes the rows", async () => {
    const t = setup(stored());
    const r = await eraseData(t.deps, EMAIL, "anonymize", ERASE_CONFIRM_WORD);
    expect(r).toEqual({ ok: true, outcome: { articles: 2, unpublished: 0, submitterRows: 2, photos: 2, recipients: 1, likes: 0, comments: 0 } });
    expect(t.removed).toEqual([{ bucket: "private", paths: ["p1.webp"] }, { bucket: "public", paths: ["1111-2222.webp"] }]);
    expect(t.updates[0]).toEqual({
      id: "a1",
      // the public photo was theirs: the story gets its department's default image
      patch: { author_first_name: null, author_last_name: null, author_department: null, image_credit: null, image_url: "/images/defaults/ev.svg" },
    });
    expect(t.updates[1].patch).toEqual({ author_first_name: null, author_last_name: null, author_department: null, image_credit: null });
    expect(t.updates.every((u) => u.patch.status === undefined)).toBe(true); // still published
  });

  it("unpublish: a published story also leaves the site; one that was not published keeps its status", async () => {
    const t = setup(stored());
    const r = await eraseData(t.deps, EMAIL, "unpublish", ERASE_CONFIRM_WORD);
    expect(r).toMatchObject({ ok: true, outcome: { unpublished: 1 } });
    expect(t.updates[0].patch).toMatchObject({ status: "pending_review", published_at: null, author_first_name: null });
    expect(t.updates[1].patch.status).toBeUndefined();
  });

  it("does the steps in a safe order: photos, stories, recipient, submitter rows, log", async () => {
    const t = setup(stored());
    await eraseData(t.deps, EMAIL, "anonymize", ERASE_CONFIRM_WORD);
    expect(t.calls.filter((c) => !c.startsWith("submissionsOf"))).toEqual([
      "removePhotos private",
      "removePhotos public",
      "updateArticle a1",
      "updateArticle a2",
      "deleteRecipients",
      "deleteSubmitters",
      "log",
    ]);
  });

  it("writes an audit entry with the admin, a keyed hash and counts: never the address", async () => {
    const t = setup(stored());
    await eraseData(t.deps, EMAIL, "unpublish", ERASE_CONFIRM_WORD);
    expect(t.logs).toHaveLength(1);
    const entry = t.logs[0];
    expect(entry).toMatchObject({ admin_email: "editor@adorpower.com", action: "erase_person", subject_hash: subjectHash(EMAIL, SECRET) });
    expect(entry.detail).toEqual({ mode: "unpublish", articles: 2, unpublished: 1, submitterRows: 2, photos: 2, recipients: 1, likes: 0, comments: 0 });
    const text = JSON.stringify(entry);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toMatch(/ada\.lovelace|lovelace@/i);
    expect(text).not.toContain("Pilot line finished"); // no headline either
  });

  it("changes nothing when a photo file cannot be removed, and says so", async () => {
    const t = setup({ ...stored(), privateFail: 1 });
    const r = await eraseData(t.deps, EMAIL, "anonymize", ERASE_CONFIRM_WORD);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("nothing was changed") });
    expect(t.store.updateArticle).not.toHaveBeenCalled();
    expect(t.store.deleteSubmitters).not.toHaveBeenCalled();
    expect(t.store.log).not.toHaveBeenCalled();
  });

  it("reports an address with nothing stored instead of writing a log entry", async () => {
    const t = setup();
    expect(await eraseData(t.deps, EMAIL, "anonymize", ERASE_CONFIRM_WORD)).toEqual({ ok: false, error: "Nothing is stored for that address." });
    expect(t.store.log).not.toHaveBeenCalled();
  });

  it("erases a person who is only on the digest list", async () => {
    const t = setup({ recipients: ["r9"] });
    const r = await eraseData(t.deps, EMAIL, "anonymize", ERASE_CONFIRM_WORD);
    expect(r).toEqual({ ok: true, outcome: { articles: 0, unpublished: 0, submitterRows: 0, photos: 0, recipients: 1, likes: 0, comments: 0 } });
    expect(t.store.deleteSubmitters).not.toHaveBeenCalled();
  });

  it("a failed audit write does not undo the erasure: it is reported as a warning", async () => {
    const t = setup({ ...stored(), logFails: true });
    const r = await eraseData(t.deps, EMAIL, "anonymize", ERASE_CONFIRM_WORD);
    expect(r).toMatchObject({ ok: true, outcome: { articles: 2, warning: expect.stringContaining("audit log entry could not be written") } });
  });

  it("works out the plan again: what the form showed earlier is not trusted", async () => {
    const t = setup(stored());
    await eraseData(t.deps, EMAIL, "anonymize", ERASE_CONFIRM_WORD);
    expect(t.store.submissionsOf).toHaveBeenCalledTimes(1);
    expect(t.store.recipientsOf).toHaveBeenCalledTimes(1);
  });
});

describe("what a person did as a Write author and as a reader", () => {
  it("counts the private images of their blocks story with their photo, and removes them first", async () => {
    const t = setup({ articles: [article({ id: "a1", image_path: null, image_paths: ["s/i1.webp", "s/i2.webp"] })] });
    const plan = await planErasure(t.deps, EMAIL);
    expect(plan.ok && plan.plan.privatePhotos).toEqual(["s/i1.webp", "s/i2.webp"]);
    const r = await eraseData(t.deps, EMAIL, "anonymize", "DELETE");
    expect(r).toMatchObject({ ok: true, outcome: { photos: 2 } });
    expect(t.removed).toEqual([{ bucket: "private", paths: ["s/i1.webp", "s/i2.webp"] }]);
  });

  it("finds the likes and comments made from the address (by its keyed hash) and deletes them, and logs only the counts", async () => {
    const t = setup({ reader: { likes: 3, comments: 2 } });
    const plan = await planErasure(t.deps, "  ADA.Lovelace@AdorPower.com ");
    expect(plan).toMatchObject({ ok: true, plan: { readerLikes: 3, readerComments: 2, empty: false } });
    const asked = (t.store.readerDataOf as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(asked).toMatch(/^[0-9a-f]{64}$/);
    expect(asked).not.toContain("ada");
    const r = await eraseData(t.deps, EMAIL, "anonymize", "DELETE");
    expect(r).toMatchObject({ ok: true, outcome: { likes: 3, comments: 2 } });
    expect(t.store.deleteReaderData).toHaveBeenCalledWith(asked);
    expect(t.logs[0].detail).toMatchObject({ likes: 3, comments: 2 });
    expect(JSON.stringify(t.logs.map((l) => l.detail))).not.toMatch(/ada|lovelace|adorpower/i); // (the admin's own address is in the log by design)
  });

  it("an address that only has reader data is not 'nothing stored'", async () => {
    const t = setup({ reader: { likes: 1, comments: 0 } });
    expect(await eraseData(t.deps, EMAIL, "anonymize", "DELETE")).toMatchObject({ ok: true, outcome: { likes: 1, articles: 0 } });
  });

  it("does not touch reader data when there is none", async () => {
    const t = setup({ articles: [article({ id: "a1" })] });
    await eraseData(t.deps, EMAIL, "anonymize", "DELETE");
    expect(t.store.deleteReaderData).not.toHaveBeenCalled();
  });
});