-- Run in the Supabase SQL editor (as the default `postgres` role). Idempotent: safe to run again.
-- Same statements as the "AI & Technology and employee submissions" section at the end of schema.sql.

-- ---------------------------------------------------------------------------
-- 1. AI & Technology department (company news) and its feeds
-- ---------------------------------------------------------------------------
alter table public.departments add column if not exists kind text not null default 'company'
  check (kind in ('company', 'world'));

insert into public.departments (name, slug, description, kind, keywords)
values (
  'AI & Technology',
  'ai-technology',
  'Artificial intelligence and machine learning, LLMs and generative AI, AI regulation and safety, robotics and automation, semiconductors and AI chips, cloud and data-center technology, and cybersecurity.',
  'company',
  array['artificial intelligence','ai','machine learning','deep learning','neural network','llm','llms','large language model','generative ai','genai','chatgpt','openai','anthropic','claude','gemini','copilot','foundation model','ai agent','agentic','ai regulation','ai safety','ai act','robot','robots','robotics','humanoid','automation','semiconductor','semiconductors','chip','chips','gpu','gpus','nvidia','tsmc','data center','data centre','cloud','cybersecurity','ransomware','vulnerability','data breach']
)
on conflict do nothing;

-- Keeps the description and keywords in step with the code (lib/config.ts AI_TECH_DESCRIPTION). Re-running this resets them.
update public.departments
set description = 'Artificial intelligence and machine learning, LLMs and generative AI, AI regulation and safety, robotics and automation, semiconductors and AI chips, cloud and data-center technology, and cybersecurity.',
    kind = 'company',
    keywords = array['artificial intelligence','ai','machine learning','deep learning','neural network','llm','llms','large language model','generative ai','genai','chatgpt','openai','anthropic','claude','gemini','copilot','foundation model','ai agent','agentic','ai regulation','ai safety','ai act','robot','robots','robotics','humanoid','automation','semiconductor','semiconductors','chip','chips','gpu','gpus','nvidia','tsmc','data center','data centre','cloud','cybersecurity','ransomware','vulnerability','data breach']
where slug = 'ai-technology';

-- Feeds checked on 2026-10-15: HTTP 200 and valid RSS/Atom with items from the last two days.
-- (VentureBeat answered 429 to the newsroom's User-Agent, so it is not seeded.)
-- country_code stays null: these are global publishers; the write agent supplies the story's country.
insert into public.sources (name, rss_url, department_id, active)
select s.name, s.rss_url, d.id, true
from (values
  ('MIT Technology Review - AI',  'https://www.technologyreview.com/topic/artificial-intelligence/feed'),
  ('The Verge - AI',              'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'),
  ('Ars Technica - Technology Lab','https://feeds.arstechnica.com/arstechnica/technology-lab'),
  ('IEEE Spectrum - AI',          'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss'),
  ('Google - AI blog',            'https://blog.google/innovation-and-ai/technology/ai/rss/'),
  ('TechCrunch - AI',             'https://techcrunch.com/category/artificial-intelligence/feed/')
) as s(name, rss_url)
cross join (select id from public.departments where slug = 'ai-technology') d
on conflict (rss_url) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Who wrote an article: new columns on articles (existing rows are AI articles)
-- ---------------------------------------------------------------------------
alter table public.articles add column if not exists origin text not null default 'ai';
alter table public.articles drop constraint if exists articles_origin_check;
alter table public.articles add constraint articles_origin_check check (origin in ('ai', 'employee'));
alter table public.articles add column if not exists author_first_name text;
alter table public.articles add column if not exists author_last_name text;
alter table public.articles add column if not exists author_department text;   -- the author's own company department
alter table public.articles drop constraint if exists articles_employee_author_check;
alter table public.articles add constraint articles_employee_author_check
  check (origin <> 'employee' or (author_first_name is not null and author_last_name is not null));
create index if not exists articles_origin_idx on public.articles (origin) where status = 'pending_review';

-- ---------------------------------------------------------------------------
-- 3. Private table for the submitter's details. Not readable by anon or authenticated, ever:
--    RLS is on with no policy, and the table privileges are revoked as well.
-- ---------------------------------------------------------------------------
create table if not exists public.article_submitters (
  article_id     uuid primary key references public.articles(id) on delete cascade,
  email          text not null,
  ip_hash        text,                                  -- keyed hash of the network address; the raw IP is never stored
  email_verified boolean not null default false,        -- true: the domain matched ALLOWED_EMAIL_DOMAINS when it was sent
  submitted_at   timestamptz not null default now(),
  image_path     text                                   -- object in the private submission-images bucket, if a photo was sent
);
alter table public.article_submitters add column if not exists email text;
alter table public.article_submitters add column if not exists ip_hash text;
alter table public.article_submitters add column if not exists email_verified boolean not null default false;
alter table public.article_submitters add column if not exists submitted_at timestamptz not null default now();
alter table public.article_submitters add column if not exists image_path text;
create index if not exists article_submitters_ip_idx    on public.article_submitters (ip_hash, submitted_at desc);
create index if not exists article_submitters_email_idx on public.article_submitters (email, submitted_at desc);

alter table public.article_submitters enable row level security;   -- no policies: only the service role gets in
revoke all on public.article_submitters from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Storage: a private bucket for photos waiting for review, a public one for published photos
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('submission-images', 'submission-images', false, 5242880, array['image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('article-images', 'article-images', true, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- submission-images: no policy at all for anon or authenticated, so only the service role (the server) can
-- upload, read or sign URLs for it. article-images: anyone may read; nobody but the service role may write.
drop policy if exists "public reads published article images" on storage.objects;
create policy "public reads published article images"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'article-images');

-- ---------------------------------------------------------------------------
-- 5. Make the API pick up the new columns and tables now
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
