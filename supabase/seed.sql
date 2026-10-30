-- Seed data. Run after schema.sql. Safe to re-run (ON CONFLICT DO NOTHING).
-- RSS URLs below are PLACEHOLDERS: edit them (or update the sources table) before running ingest.

insert into public.departments (name, slug, description, keywords) values
  ('EV', 'ev',
   'Electric vehicles: passenger and commercial EVs, charging infrastructure, drivetrains, EV policy and incentives.',
   array['electric vehicle','ev','evs','charging','charger','e-mobility','drivetrain','electric motor','plug-in','hybrid','zero-emission','tesla','byd','autonomous driving']),
  ('Batteries', 'batteries',
   'Battery cells, packs and chemistry: lithium-ion, solid-state, sodium-ion, gigafactories, recycling and raw materials.',
   array['battery','batteries','lithium','li-ion','solid-state','sodium-ion','cathode','anode','gigafactory','cell','energy storage','bms','recycling','nickel','cobalt','graphite']),
  ('Defence', 'defence',
   'Defence and aerospace: military procurement, defence electronics, unmanned systems, contracts and policy.',
   array['defence','defense','military','army','navy','air force','drone','uav','unmanned','procurement','missile','radar','armoured','nato','ministry of defence','aerospace']),
  ('Software Development', 'software',
   'Software engineering: embedded and automotive software, cloud, AI/ML tooling, cybersecurity and developer practices.',
   array['software','developer','programming','cloud','api','open source','ai','machine learning','cybersecurity','embedded','firmware','devops','kubernetes','sdk','over-the-air','ota']),
  ('Sales & Marketing', 'sales-marketing',
   'Market and commercial news: sales figures, market share, pricing, partnerships, launches, campaigns and customer trends.',
   array['sales','market share','pricing','price','revenue','partnership','launch','marketing','campaign','customer','demand','deliveries','registrations','dealer','b2b'])
on conflict (name) do nothing;

-- The placeholder feeds are inserted INACTIVE: they point at example.com, so an active one would fail on every ingest run. Replace the URL and set
-- active = true in the sources table (Table Editor) when you add a real feed. A re-run never changes a row that already exists.
insert into public.sources (name, rss_url, department_id, active)
select s.name, s.rss_url, d.id, false
from (values
  ('EV source 1 (placeholder)',        'https://example.com/replace-me/ev-1.xml',        'ev'),
  ('EV source 2 (placeholder)',        'https://example.com/replace-me/ev-2.xml',        'ev'),
  ('Batteries source 1 (placeholder)', 'https://example.com/replace-me/batteries-1.xml', 'batteries'),
  ('Batteries source 2 (placeholder)', 'https://example.com/replace-me/batteries-2.xml', 'batteries'),
  ('Defence source 1 (placeholder)',   'https://example.com/replace-me/defence-1.xml',   'defence'),
  ('Defence source 2 (placeholder)',   'https://example.com/replace-me/defence-2.xml',   'defence'),
  ('Software source 1 (placeholder)',  'https://example.com/replace-me/software-1.xml',  'software'),
  ('Software source 2 (placeholder)',  'https://example.com/replace-me/software-2.xml',  'software'),
  ('Sales & Marketing source 1 (placeholder)', 'https://example.com/replace-me/sales-1.xml', 'sales-marketing'),
  ('Sales & Marketing source 2 (placeholder)', 'https://example.com/replace-me/sales-2.xml', 'sales-marketing')
) as s(name, rss_url, dept_slug)
join public.departments d on d.slug = s.dept_slug
on conflict (rss_url) do nothing;

-- ---------------------------------------------------------------------------
-- World news feeds (each URL checked on 2026-10-14: HTTP 200, valid RSS/RDF with recent items).
-- country_code is left null on purpose: these are global publishers, so the country of each story
-- comes from the write agent. A fallback country here would put every unlocated story on the
-- publisher's home country.
-- ---------------------------------------------------------------------------
insert into public.sources (name, rss_url, department_id, active, country_code)
select s.name, s.rss_url, d.id, true, null
from (values
  ('BBC News - World',        'https://feeds.bbci.co.uk/news/world/rss.xml'),
  ('Al Jazeera - All news',   'https://www.aljazeera.com/xml/rss/all.xml'),
  ('Deutsche Welle - World',  'https://rss.dw.com/rdf/rss-en-world'),
  ('NPR - World',             'https://feeds.npr.org/1004/rss.xml'),
  ('The Guardian - World',    'https://www.theguardian.com/world/rss'),
  ('The Hindu - International','https://www.thehindu.com/news/international/feeder/default.rss'),
  ('France 24 - English',     'https://www.france24.com/en/rss'),
  ('UN News - Global',        'https://news.un.org/feed/subscribe/en/news/all/rss.xml')
) as s(name, rss_url)
cross join (select id from public.departments where slug = 'world') d
on conflict (rss_url) do nothing;

-- The AI & Technology department and its six feeds are created by schema.sql (and by supabase/migrations/2026-10-15-ai-tech-and-submissions.sql on an existing database).
